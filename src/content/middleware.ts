// DIG Extension Middleware System
// Implements all fallback strategies in priority order

/**
 * A DOM element this middleware may load a chia:// resource onto. The vanilla code reads/writes
 * `src`/`srcset`/`href`/`data`/`alt` across many element kinds after a `tagName` guard, so this
 * intersection exposes those (as `string`) on top of `HTMLElement`; each is only touched inside the
 * matching `tagName` branch, so the runtime behavior is unchanged.
 */
type DigElement = HTMLElement & {
  src: string;
  srcset: string;
  href: string;
  data: string;
  alt: string;
};

// Cache for RPC host configuration. Default MUST match the dig-node's actual default port
// (8080 — server-config.mjs DEFAULT_DIG_NODE_PORT), not the http-standard 80. Content scripts
// are classic (non-module) scripts and can't `import` the shared constant, so it's a literal
// here — keep it in lockstep with server-config.mjs. Promoted onto globalThis so content.js
// (a separate IIFE in the SAME isolated world) reads the live value.
globalThis.cachedRpcHost = 'localhost:8080';

// Get RPC host from storage (async)
async function updateRpcHostCache(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const result = await chrome.storage.local.get(['server.host', 'server.url', 'server.port']);

      let newRpcHost = 'localhost:8080';

      if (result['server.host']) {
        newRpcHost = result['server.host'];
      } else if (result['server.url'] || result['server.port']) {
        // Fallback to old format
        const url = result['server.url'] || 'localhost';
        const port = result['server.port'] || 8080;
        newRpcHost = `${url}:${port}`;
      }

      // Only update if changed
      if (globalThis.cachedRpcHost !== newRpcHost) {
        globalThis.cachedRpcHost = newRpcHost;
        console.log('DIG Extension: RPC host updated to:', globalThis.cachedRpcHost);

        // Notify content scripts to update their cache
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          try {
            const tabs = await chrome.tabs.query({});
            tabs.forEach(tab => {
              if (tab.id === undefined) return;
              chrome.tabs.sendMessage(tab.id, {
                action: 'updateRpcHost',
                rpcHost: globalThis.cachedRpcHost
              }).catch(() => {
                // Ignore errors (tab might not have content script loaded)
              });
            });
          } catch {
            // Ignore errors
          }
        }
      }
    }
  } catch (error) {
    console.warn('DIG Extension: Failed to get RPC host from storage:', error);
  }
}

// Initialize cache
if (typeof chrome !== 'undefined' && chrome.storage) {
  updateRpcHostCache();

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes['server.host'] || changes['server.url'] || changes['server.port']) {
        updateRpcHostCache();
      }
    }
  });
}

// ============================================================================
// Priority 5: Request Retry Logic
// ============================================================================

// Exponential backoff retry
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 100): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = Math.pow(2, i) * baseDelay;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('retryWithBackoff: retries exhausted');
}

// Circuit breaker pattern
class CircuitBreaker {
  failures: number;
  threshold: number;
  timeout: number;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  lastFailure: number;

  constructor(threshold = 5, timeout = 60000) {
    this.failures = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.lastFailure = 0;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess(): void {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
    }
  }

  onFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
    }
  }

  reset(): void {
    this.failures = 0;
    this.state = 'CLOSED';
    this.lastFailure = 0;
  }
}

// ============================================================================
// Priority 6: Request Queuing
// ============================================================================

/** One queued request awaiting a free concurrency slot. */
interface QueueItem {
  request: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  priority: number;
}

class RequestQueue {
  queue: QueueItem[];
  processing: boolean;
  maxConcurrent: number;
  active: number;

  constructor(maxConcurrent = 5) {
    this.queue = [];
    this.processing = false;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
  }

  async enqueue<T>(request: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        request: request as () => Promise<unknown>,
        priority,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.process();
    });
  }

  async process(): Promise<void> {
    if (this.processing || this.active >= this.maxConcurrent) return;
    this.processing = true;

    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      const item = this.queue.shift();
      if (!item) break;
      const { request, resolve, reject } = item;
      this.active++;

      try {
        const result = await request();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        this.active--;
      }
    }

    this.processing = false;
    if (this.queue.length > 0) {
      setTimeout(() => this.process(), 0);
    }
  }

  clear(): void {
    this.queue = [];
  }

  size(): number {
    return this.queue.length;
  }
}

// ============================================================================
// Priority 10: Error Recovery & Reporting
// ============================================================================

function reportError(digUrl: string, error: unknown, strategy: string): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        action: 'reportError',
        url: digUrl,
        error: (error as { message?: string }).message || String(error),
        strategy,
        timestamp: Date.now()
      });
    }
  } catch (e) {
    console.warn('DIG Extension: Failed to report error', e);
  }
}

function reportSuccess(digUrl: string, strategy: string): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        action: 'reportSuccess',
        url: digUrl,
        strategy,
        timestamp: Date.now()
      });
    }
  } catch {
    // Ignore reporting errors
  }
}

function injectFallback(element: DigElement, digUrl: string): void {
  if (element.tagName === 'IMG') {
    // SVG placeholder
    const placeholder = 'data:image/svg+xml,' + encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
        <rect width="200" height="200" fill="#f0f0f0"/>
        <text x="50%" y="50%" text-anchor="middle" dy=".3em" font-family="Arial" font-size="14" fill="#999">
          Failed to load: ${digUrl}
        </text>
      </svg>
    `);
    element.src = placeholder;
    element.alt = `Failed to load: ${digUrl}`;
  } else if (element.tagName === 'SCRIPT') {
    // Inject error handler
    element.textContent = `console.error('DIG Extension: Failed to load script: ${digUrl}');`;
  } else if (element.tagName === 'LINK') {
    // Remove failed stylesheet
    element.remove();
  }
}

// ============================================================================
// Main Resource Loader with All Strategies
// ============================================================================

class DigResourceLoader implements DigResourceLoaderApi {
  requestQueue: RequestQueue;
  circuitBreaker: CircuitBreaker;
  errorHandlers: Map<Element, EventListener>;
  loadHandlers: Map<Element, EventListener>;

  constructor() {
    this.requestQueue = new RequestQueue();
    this.circuitBreaker = new CircuitBreaker();
    this.errorHandlers = new Map();
    this.loadHandlers = new Map();
  }

  // No-op: kept so any surviving `.init()` call site doesn't need to change. The extension
  // used to warm a memory + IndexedDB content cache here; it no longer caches resolved
  // content at all (caching is a dig-node job — #43 / #41 SoC audit decision 3), so there is
  // nothing to initialize.
  async init(): Promise<void> {}

  // Convert chia:// URL - ALL chia:// URLs now use RPC via background script
  // This function returns a placeholder that will be replaced by proxyResource
  convertDigUrl(url: string): string {
    if (typeof url === 'string' && url.startsWith('chia://')) {
      // Return a placeholder data URL that indicates RPC should be used
      // The actual fetching will be done via proxyResource or background script
      // This placeholder prevents browser errors while proxy loads
      return `data:application/octet-stream;base64,`; // Empty placeholder, will be replaced by proxy
    }
    return url;
  }

  // Strategy 1: Proxy through background worker
  async proxyResource(digUrl: string): Promise<DigProxyResponse> {
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      throw new Error('Chrome runtime not available');
    }

    return new Promise<DigProxyResponse>((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'proxyRequest', url: digUrl },
        (proxyResponse) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (proxyResponse.error) {
            reject(new Error(proxyResponse.error));
            return;
          }
          if (proxyResponse.success) {
            resolve(proxyResponse);
          } else {
            reject(new Error('Unknown proxy response'));
          }
        }
      );
    });
  }

  // Strategy 2: Proxy with retry
  async proxyWithRetry(digUrl: string): Promise<DigLoadResult> {
    return retryWithBackoff(
      () => this.proxyResource(digUrl),
      3,
      100
    ).then(response => ({
      success: true,
      strategy: 'proxy-retry',
      data: response
    }));
  }

  // Strategy 3: Redirect/URL conversion
  async redirectResource(digUrl: string): Promise<DigLoadResult> {
    const localhostUrl = this.convertDigUrl(digUrl);
    return {
      success: true,
      strategy: 'redirect',
      data: localhostUrl
    };
  }

  // Main load function with all strategies. Every call re-fetches via the background worker —
  // the extension does not cache resolved content (caching is a dig-node job; #43 / #41 SoC
  // audit decision 3).
  async loadResource(element: DigElement, _attribute: string, digUrl: string, priority = 0): Promise<DigLoadResult> {
    const strategies: Array<() => Promise<DigLoadResult>> = [
      // Strategy 1: Proxy through background worker (with circuit breaker)
      () => this.circuitBreaker.execute(() => this.proxyResource(digUrl))
        .then(response => ({ success: true, strategy: 'proxy', data: response })),

      // Strategy 2: Proxy with retry
      () => this.proxyWithRetry(digUrl),

      // Strategy 3: Redirect/URL conversion
      () => this.redirectResource(digUrl),

      // Strategy 4: Fallback content
      () => {
        injectFallback(element, digUrl);
        return Promise.resolve({ success: true, strategy: 'fallback', data: null });
      }
    ];

    // Queue the request
    return this.requestQueue.enqueue<DigLoadResult>(async () => {
      // Try each strategy in order
      for (const strategy of strategies) {
        try {
          const result = await strategy();
          if (result.success) {
            reportSuccess(digUrl, result.strategy);
            return result;
          }
        } catch (error) {
          reportError(digUrl, error, strategy.name);
          continue;
        }
      }

      // All strategies failed
      throw new Error('All fallback strategies failed for ' + digUrl);
    }, priority);
  }

  // Load resource and apply to element
  async loadAndApply(element: DigElement, attribute: string, digUrl: string, priority = 0): Promise<void> {
    try {
      const result = await this.loadResource(element, attribute, digUrl, priority);

      if (result.strategy === 'fallback') {
        // Fallback already applied
        // Remove spinner
        const spinner = element.querySelector('.dig-loading-spinner');
        if (spinner) {
          spinner.remove();
          delete element.dataset.digSpinnerInjected;
        }
        return;
      }

      if (result.strategy === 'redirect') {
        // Set the converted URL
        (element as unknown as Record<string, unknown>)[attribute] = result.data;
        // Spinner will be removed by load event handler
        return;
      }

      // For proxy strategies, convert data URL to blob URL
      if (result.data && result.data.data) {
        const blob = await (await fetch(result.data.data)).blob();
        const blobUrl = URL.createObjectURL(blob);
        (element as unknown as Record<string, unknown>)[attribute] = blobUrl;
        // Remove spinner immediately for proxied resources (they're already loaded)
        const spinner = element.querySelector('.dig-loading-spinner');
        if (spinner) {
          spinner.remove();
          delete element.dataset.digSpinnerInjected;
        }
      } else if (result.data) {
        // Direct blob/data
        (element as unknown as Record<string, unknown>)[attribute] = result.data;
        // Remove spinner immediately
        const spinner = element.querySelector('.dig-loading-spinner');
        if (spinner) {
          spinner.remove();
          delete element.dataset.digSpinnerInjected;
        }
      }
    } catch (error) {
      console.error('DIG Extension: Failed to load resource', digUrl, error);
      // Remove spinner on error
      const spinner = element.querySelector('.dig-loading-spinner');
      if (spinner) {
        spinner.remove();
        delete element.dataset.digSpinnerInjected;
      }
      // Final fallback
      injectFallback(element, digUrl);
      reportError(digUrl, error, 'final-fallback');
    }
  }

  // Register error handler for element
  registerErrorHandler(element: DigElement, _digUrl: string): void {
    if (this.errorHandlers.has(element)) return;

    const handler = (e: Event): void => {
      if (e.target === element && (element.src || element.href || element.data)?.includes('chia://')) {
        // Remove loading spinner on error
        const spinner = element.querySelector('.dig-loading-spinner');
        if (spinner) {
          spinner.remove();
          delete element.dataset.digSpinnerInjected;
        }

        e.preventDefault();
        e.stopPropagation();

        // Retry with different strategy
        const currentUrl = element.src || element.href || element.data;
        if (currentUrl && currentUrl.startsWith('chia://')) {
          // Re-inject spinner for retry
          if (typeof globalThis.injectLoadingSpinner === 'function') {
            globalThis.injectLoadingSpinner(element, currentUrl);
          }
          this.loadAndApply(element,
            element.src ? 'src' : element.href ? 'href' : 'data',
            currentUrl,
            10 // High priority for retry
          );
        }
      }
    };

    element.addEventListener('error', handler, true);
    this.errorHandlers.set(element, handler);
  }

  // Register load handler for element
  registerLoadHandler(element: DigElement, digUrl: string): void {
    if (this.loadHandlers.has(element)) return;

    const handler = (e: Event): void => {
      if (e.target === element) {
        reportSuccess(digUrl, 'load-event');
        // Remove loading spinner on successful load
        const spinner = element.querySelector('.dig-loading-spinner');
        if (spinner) {
          spinner.remove();
          delete element.dataset.digSpinnerInjected;
        }
      }
    };

    element.addEventListener('load', handler, true);
    this.loadHandlers.set(element, handler);
  }

  // Cleanup handlers
  cleanup(element: DigElement): void {
    const errorHandler = this.errorHandlers.get(element);
    if (errorHandler) {
      element.removeEventListener('error', errorHandler, true);
      this.errorHandlers.delete(element);
    }

    const loadHandler = this.loadHandlers.get(element);
    if (loadHandler) {
      element.removeEventListener('load', loadHandler, true);
      this.loadHandlers.delete(element);
    }
  }
}

// Export singleton instance onto globalThis so content.js (a separate IIFE in the same isolated
// world) can use it. init() is currently a no-op (no cache to initialize) but is still
// called/awaited-safe for forward compatibility with any future non-caching setup step.
const digResourceLoader = new DigResourceLoader();
digResourceLoader.init().catch(() => {});
globalThis.digResourceLoader = digResourceLoader;

export {};
