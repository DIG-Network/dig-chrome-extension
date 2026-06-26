// DIG Extension Middleware System
// Implements all fallback strategies in priority order

// Cache for RPC host configuration
let cachedRpcHost = 'localhost:80';

// Get RPC host from storage (async)
async function updateRpcHostCache() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const result = await chrome.storage.local.get(['server.host', 'server.url', 'server.port']);
      
      let newRpcHost = 'localhost:80';
      
      if (result['server.host']) {
        newRpcHost = result['server.host'];
      } else if (result['server.url'] || result['server.port']) {
        // Fallback to old format
        const url = result['server.url'] || 'localhost';
        const port = result['server.port'] || 80;
        newRpcHost = `${url}:${port}`;
      }
      
      // Only update if changed
      if (cachedRpcHost !== newRpcHost) {
        cachedRpcHost = newRpcHost;
        console.log('DIG Extension: RPC host updated to:', cachedRpcHost);
        
        // Notify content scripts to update their cache
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          try {
            const tabs = await chrome.tabs.query({});
            tabs.forEach(tab => {
              chrome.tabs.sendMessage(tab.id, {
                action: 'updateRpcHost',
                rpcHost: cachedRpcHost
              }).catch(() => {
                // Ignore errors (tab might not have content script loaded)
              });
            });
          } catch (e) {
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
// Priority 4: Resource Caching Middleware
// ============================================================================

// Memory cache with TTL
class MemoryCache {
  constructor(ttl = 300000) { // 5 minutes default
    this.cache = new Map();
    this.ttl = ttl;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }

  set(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

// IndexedDB cache for offline access
class IndexedDBCache {
  constructor() {
    this.dbName = 'dig-resources';
    this.version = 1;
    this.storeName = 'resources';
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'url' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  async get(url) {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(url);
      
      request.onsuccess = () => {
        const result = request.result;
        if (result && Date.now() - result.timestamp < 86400000) { // 24 hours
          resolve(result.data);
        } else {
          resolve(null);
        }
      };
      
      request.onerror = () => reject(request.error);
    });
  }

  async set(url, data) {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put({
        url,
        data,
        timestamp: Date.now()
      });
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear() {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

// ============================================================================
// Priority 5: Request Retry Logic
// ============================================================================

// Exponential backoff retry
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 100) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = Math.pow(2, i) * baseDelay;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Circuit breaker pattern
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failures = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.lastFailure = 0;
  }

  async execute(fn) {
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

  onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
    }
  }

  reset() {
    this.failures = 0;
    this.state = 'CLOSED';
    this.lastFailure = 0;
  }
}

// ============================================================================
// Priority 6: Request Queuing
// ============================================================================

class RequestQueue {
  constructor(maxConcurrent = 5) {
    this.queue = [];
    this.processing = false;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
  }

  async enqueue(request, priority = 0) {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, priority, resolve, reject });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.process();
    });
  }

  async process() {
    if (this.processing || this.active >= this.maxConcurrent) return;
    this.processing = true;

    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      const { request, resolve, reject } = this.queue.shift();
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

  clear() {
    this.queue = [];
  }

  size() {
    return this.queue.length;
  }
}

// ============================================================================
// Priority 10: Error Recovery & Reporting
// ============================================================================

function reportError(digUrl, error, strategy) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        action: 'reportError',
        url: digUrl,
        error: error.message || String(error),
        strategy: strategy,
        timestamp: Date.now()
      });
    }
  } catch (e) {
    console.warn('DIG Extension: Failed to report error', e);
  }
}

function reportSuccess(digUrl, strategy) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        action: 'reportSuccess',
        url: digUrl,
        strategy: strategy,
        timestamp: Date.now()
      });
    }
  } catch (e) {
    // Ignore reporting errors
  }
}

function injectFallback(element, digUrl) {
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

class DigResourceLoader {
  constructor() {
    this.memoryCache = new MemoryCache();
    this.indexedDBCache = new IndexedDBCache();
    this.requestQueue = new RequestQueue();
    this.circuitBreaker = new CircuitBreaker();
    this.errorHandlers = new Map();
    this.loadHandlers = new Map();
  }

  // Initialize caches
  async init() {
    try {
      await this.indexedDBCache.init();
    } catch (error) {
      console.warn('DIG Extension: IndexedDB cache init failed', error);
    }
  }

  // Convert chia:// URL - ALL chia:// URLs now use RPC via background script
  // This function returns a placeholder that will be replaced by proxyResource
  convertDigUrl(url) {
    if (typeof url === 'string' && url.startsWith('chia://')) {
      // Return a placeholder data URL that indicates RPC should be used
      // The actual fetching will be done via proxyResource or background script
      // This placeholder prevents browser errors while proxy loads
      return `data:application/octet-stream;base64,`; // Empty placeholder, will be replaced by proxy
    }
    return url;
  }

  // Strategy 1: Proxy through background worker
  async proxyResource(digUrl) {
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      throw new Error('Chrome runtime not available');
    }
    
    return new Promise((resolve, reject) => {
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

  // Strategy 2: Check memory cache
  async getFromMemoryCache(digUrl) {
    const cached = this.memoryCache.get(digUrl);
    if (cached) {
      return { success: true, strategy: 'memory-cache', data: cached };
    }
    throw new Error('Not in memory cache');
  }

  // Strategy 3: Check IndexedDB cache
  async getFromIndexedDBCache(digUrl) {
    try {
      const cached = await this.indexedDBCache.get(digUrl);
      if (cached) {
        // Also update memory cache
        this.memoryCache.set(digUrl, cached);
        return { success: true, strategy: 'indexeddb-cache', data: cached };
      }
      throw new Error('Not in IndexedDB cache');
    } catch (error) {
      throw new Error('IndexedDB cache error: ' + error.message);
    }
  }

  // Strategy 4: Proxy with retry
  async proxyWithRetry(digUrl) {
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

  // Strategy 5: Redirect/URL conversion
  async redirectResource(digUrl) {
    const localhostUrl = this.convertDigUrl(digUrl);
    return {
      success: true,
      strategy: 'redirect',
      data: localhostUrl
    };
  }

  // Main load function with all strategies
  async loadResource(element, attribute, digUrl, priority = 0) {
    const strategies = [
      // Strategy 1: Memory cache (fastest)
      () => this.getFromMemoryCache(digUrl),
      
      // Strategy 2: IndexedDB cache
      () => this.getFromIndexedDBCache(digUrl),
      
      // Strategy 3: Proxy through background worker (with circuit breaker)
      () => this.circuitBreaker.execute(() => this.proxyResource(digUrl))
        .then(response => {
          // Cache the result
          const blob = response.data;
          this.memoryCache.set(digUrl, blob);
          this.indexedDBCache.set(digUrl, blob).catch(() => {
            // Ignore cache errors
          });
          return { success: true, strategy: 'proxy', data: response };
        }),
      
      // Strategy 4: Proxy with retry
      () => this.proxyWithRetry(digUrl)
        .then(response => {
          // Cache the result
          const blob = response.data.data;
          this.memoryCache.set(digUrl, blob);
          this.indexedDBCache.set(digUrl, blob).catch(() => {});
          return response;
        }),
      
      // Strategy 5: Redirect/URL conversion
      () => this.redirectResource(digUrl),
      
      // Strategy 6: Fallback content
      () => {
        injectFallback(element, digUrl);
        return { success: true, strategy: 'fallback', data: null };
      }
    ];

    // Queue the request
    return this.requestQueue.enqueue(async () => {
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
  async loadAndApply(element, attribute, digUrl, priority = 0) {
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
        element[attribute] = result.data;
        // Spinner will be removed by load event handler
        return;
      }

      // For proxy strategies, convert data URL to blob URL
      if (result.data && result.data.data) {
        const blob = await (await fetch(result.data.data)).blob();
        const blobUrl = URL.createObjectURL(blob);
        element[attribute] = blobUrl;
        // Remove spinner immediately for proxied resources (they're already loaded)
        const spinner = element.querySelector('.dig-loading-spinner');
        if (spinner) {
          spinner.remove();
          delete element.dataset.digSpinnerInjected;
        }
      } else if (result.data) {
        // Direct blob/data
        element[attribute] = result.data;
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
  registerErrorHandler(element, digUrl) {
    if (this.errorHandlers.has(element)) return;
    
    const handler = (e) => {
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
          if (typeof injectLoadingSpinner === 'function') {
            injectLoadingSpinner(element, currentUrl);
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
  registerLoadHandler(element, digUrl) {
    if (this.loadHandlers.has(element)) return;
    
    const handler = (e) => {
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
  cleanup(element) {
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

// Export singleton instance
const digResourceLoader = new DigResourceLoader();
digResourceLoader.init().catch(() => {
  // Ignore init errors, will fallback to memory cache only
});

