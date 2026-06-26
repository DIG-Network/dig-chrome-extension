# DIG Extension Fallback Strategies & Middleware Options

## Current Fallback Chain

### Priority 1: Proxy Through Background Worker ✅ (Currently Implemented)
- **Method**: `chrome.runtime.sendMessage` → Background Service Worker → Fetch from localhost → Return as data URL/blob
- **Advantages**: 
  - No network errors visible to browser
  - Resources load as blob/data URLs
  - Caching in background worker
- **Limitations**: 
  - Requires background worker to be active
  - Async communication overhead
  - Some resources (iframes) can't use blob URLs

### Priority 2: Redirect/URL Conversion ✅ (Currently Implemented)
- **Method**: Convert `chia://` URLs to `http://localhost:8080/` and let browser fetch normally
- **Advantages**: 
  - Simple and reliable
  - Works for all resource types
  - Browser handles caching, retries, etc.
- **Limitations**: 
  - Network errors visible in console
  - Requires localhost server to be running
  - Less seamless user experience

---

## Additional Fallback Strategies

### Priority 3: JavaScript Event Middleware (Suggested)

#### 3a. Error Event Interception
```javascript
// Intercept error events before they bubble
element.addEventListener('error', (e) => {
  if (e.target.src?.startsWith('chia://')) {
    e.preventDefault();
    e.stopPropagation();
    // Retry with different method
  }
}, true); // Capture phase
```

**Use Cases:**
- Catch failed resource loads
- Retry with redirect if proxy fails
- Suppress error messages
- Show fallback content

#### 3b. Load Event Middleware
```javascript
// Intercept successful loads to verify they worked
element.addEventListener('load', (e) => {
  // Verify resource actually loaded
  // Log success metrics
  // Update cache
}, true);
```

**Use Cases:**
- Verify proxy success
- Update statistics
- Preload related resources

#### 3c. Abort Event Handling
```javascript
// Handle cancelled requests
element.addEventListener('abort', (e) => {
  // Retry with different strategy
  // Queue for later retry
}, true);
```

---

### Priority 4: Resource Caching Middleware

#### 4a. IndexedDB Caching
```javascript
// Store proxied resources in IndexedDB for offline access
async function cacheResource(digUrl, blob) {
  const db = await openDB('dig-resources', 1);
  await db.put('resources', { url: digUrl, blob, timestamp: Date.now() });
}
```

**Benefits:**
- Offline access to previously loaded resources
- Faster subsequent loads
- Reduced server load

#### 4b. Memory Cache with TTL
```javascript
// In-memory cache with expiration
const memoryCache = new Map();
function getCachedResource(digUrl) {
  const cached = memoryCache.get(digUrl);
  if (cached && Date.now() - cached.timestamp < TTL) {
    return cached.data;
  }
  return null;
}
```

**Benefits:**
- Fast access for recently used resources
- Automatic cleanup of old entries
- No disk I/O overhead

#### 4c. Service Worker Cache API
```javascript
// Use Cache API in background worker
const cache = await caches.open('dig-resources-v1');
await cache.put(digUrl, response);
```

**Benefits:**
- Browser-managed caching
- Automatic cache invalidation
- Works across page reloads

---

### Priority 5: Request Retry Middleware

#### 5a. Exponential Backoff Retry
```javascript
async function proxyWithRetry(digUrl, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await proxyResource(digUrl);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(Math.pow(2, i) * 100); // 100ms, 200ms, 400ms
    }
  }
}
```

**Benefits:**
- Handles transient network errors
- Reduces server load during outages
- Improves reliability

#### 5b. Circuit Breaker Pattern
```javascript
// Stop trying if too many failures
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failures = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
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
}
```

**Benefits:**
- Prevents cascading failures
- Fast failure when service is down
- Automatic recovery attempts

---

### Priority 6: Request Queuing Middleware

#### 6a. Request Queue with Priority
```javascript
class RequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.maxConcurrent = 5;
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
}
```

**Benefits:**
- Prevents overwhelming the server
- Prioritizes critical resources
- Better resource management

#### 6b. Batch Request Processing
```javascript
// Group multiple requests and process together
async function batchProxy(digUrls) {
  const requests = digUrls.map(url => proxyRequest(url));
  return Promise.allSettled(requests);
}
```

**Benefits:**
- Reduced overhead
- Parallel processing
- Better error handling

---

### Priority 7: Resource Preloading Middleware

#### 7a. Predictive Preloading
```javascript
// Preload resources based on page structure
function preloadRelatedResources(element) {
  // If image loaded, preload related images
  // If script loaded, preload dependencies
  // If stylesheet loaded, preload fonts/images in CSS
}
```

**Benefits:**
- Faster page loads
- Better user experience
- Reduced perceived latency

#### 7b. Resource Hints
```javascript
// Inject resource hints for browser preloading
function addResourceHint(digUrl, type = 'prefetch') {
  const link = document.createElement('link');
  link.rel = type; // prefetch, preload, preconnect
  link.href = convertDigUrl(digUrl);
  document.head.appendChild(link);
}
```

**Benefits:**
- Browser-native preloading
- Better caching
- Reduced load times

---

### Priority 8: Alternative Protocol Handlers

#### 8a. WebSocket Fallback
```javascript
// If HTTP fails, try WebSocket connection
async function proxyViaWebSocket(digUrl) {
  const ws = new WebSocket('ws://localhost:8080/ws');
  return new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ url: digUrl }));
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    ws.onerror = reject;
  });
}
```

**Benefits:**
- Alternative transport mechanism
- Real-time updates possible
- Bypasses HTTP limitations

#### 8b. MessageChannel/PostMessage Bridge
```javascript
// Use MessageChannel for cross-context communication
const channel = new MessageChannel();
channel.port1.onmessage = (e) => {
  // Handle proxied resource
};
// Send request to background worker
```

**Benefits:**
- Direct communication
- Lower latency
- Better for large payloads

---

### Priority 9: DOM Manipulation Middleware

#### 9a. MutationObserver for Dynamic Content
```javascript
// Watch for new elements with chia:// URLs
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === 1) { // Element node
        processElement(node);
      }
    });
  });
});
observer.observe(document, { childList: true, subtree: true });
```

**Benefits:**
- Catches dynamically added content
- No polling needed
- Efficient DOM watching

#### 9b. Element Replacement Middleware
```javascript
// Replace elements with chia:// URLs before browser loads them
function replaceElement(element) {
  const newElement = element.cloneNode(true);
  // Process newElement
  element.parentNode.replaceChild(newElement, element);
}
```

**Benefits:**
- Prevents browser from seeing chia:// URLs
- Cleaner DOM
- Better error handling

---

### Priority 10: Error Recovery Middleware

#### 10a. Fallback Content Injection
```javascript
// If resource fails, inject placeholder
function injectFallback(element, digUrl) {
  if (element.tagName === 'IMG') {
    element.src = 'data:image/svg+xml,<svg>...</svg>'; // Placeholder
    element.alt = 'Failed to load: ' + digUrl;
  }
}
```

**Benefits:**
- Better UX during failures
- Visual feedback
- Prevents broken layouts

#### 10b. Error Reporting & Analytics
```javascript
// Track failures for debugging
function reportError(digUrl, error, strategy) {
  chrome.runtime.sendMessage({
    action: 'reportError',
    url: digUrl,
    error: error.message,
    strategy: strategy,
    timestamp: Date.now()
  });
}
```

**Benefits:**
- Debugging information
- Performance metrics
- Failure pattern analysis

---

### Priority 11: Content Security Policy (CSP) Bypass

#### 11a. CSP Header Modification
```javascript
// Modify CSP headers to allow chia:// resources
// Note: Limited by browser security policies
```

**Benefits:**
- Allows inline resources
- Bypasses some restrictions
- More flexible resource loading

**Limitations:**
- Browser security restrictions
- May not work in all contexts
- Requires careful implementation

---

### Priority 12: Service Worker in Page Context

#### 12a. Page-Level Service Worker
```javascript
// Register service worker in page context
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/dig-sw.js')
    .then(reg => {
      // Service worker can intercept fetch requests
    });
}
```

**Benefits:**
- Intercepts all fetch requests
- Works offline
- Better caching

**Limitations:**
- Requires HTTPS (or localhost)
- More complex setup
- May conflict with page's own SW

---

## Recommended Implementation Order

1. ✅ **Proxy through background worker** (Current Priority 1)
2. ✅ **Redirect fallback** (Current Priority 2)
3. **JavaScript event middleware** (Priority 3)
   - Error event interception
   - Load event verification
   - Abort event handling
4. **Resource caching** (Priority 4)
   - IndexedDB for offline access
   - Memory cache for performance
5. **Request retry logic** (Priority 5)
   - Exponential backoff
   - Circuit breaker pattern
6. **Request queuing** (Priority 6)
   - Priority queue
   - Batch processing
7. **Resource preloading** (Priority 7)
   - Predictive preloading
   - Resource hints
8. **Alternative protocols** (Priority 8)
   - WebSocket fallback
   - MessageChannel bridge
9. **DOM manipulation** (Priority 9)
   - MutationObserver
   - Element replacement
10. **Error recovery** (Priority 10)
    - Fallback content
    - Error reporting
11. **CSP bypass** (Priority 11)
    - Header modification
12. **Service worker** (Priority 12)
    - Page-level SW registration

---

## Implementation Example: Enhanced Fallback Chain

```javascript
async function loadDigResource(element, attribute, digUrl) {
  const strategies = [
    // Strategy 1: Proxy through background worker
    async () => {
      const response = await proxyResource(element, attribute, digUrl);
      return { success: true, strategy: 'proxy', data: response };
    },
    
    // Strategy 2: Redirect/URL conversion
    async () => {
      const localhostUrl = convertDigUrl(digUrl);
      element[attribute] = localhostUrl;
      return { success: true, strategy: 'redirect', data: localhostUrl };
    },
    
    // Strategy 3: Retry proxy with exponential backoff
    async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await sleep(Math.pow(2, i) * 100);
          const response = await proxyResource(element, attribute, digUrl);
          return { success: true, strategy: 'proxy-retry', data: response };
        } catch (e) {
          if (i === 2) throw e;
        }
      }
    },
    
    // Strategy 4: Check cache
    async () => {
      const cached = await getCachedResource(digUrl);
      if (cached) {
        element[attribute] = cached;
        return { success: true, strategy: 'cache', data: cached };
      }
      throw new Error('Not in cache');
    },
    
    // Strategy 5: Inject fallback content
    async () => {
      injectFallback(element, digUrl);
      return { success: true, strategy: 'fallback', data: null };
    }
  ];
  
  // Try each strategy in order
  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result.success) {
        // Log success
        reportSuccess(digUrl, result.strategy);
        return result;
      }
    } catch (error) {
      // Log failure and try next strategy
      reportError(digUrl, error, strategy.name);
      continue;
    }
  }
  
  // All strategies failed
  throw new Error('All fallback strategies failed for ' + digUrl);
}
```

---

## Middleware Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User Request                          │
│                   (chia:// URL)                          │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Event Middleware Layer                      │
│  • Error interception                                   │
│  • Load verification                                    │
│  • Abort handling                                       │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│            Request Queue Middleware                      │
│  • Priority queue                                       │
│  • Rate limiting                                        │
│  • Batch processing                                     │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│            Cache Middleware Layer                        │
│  • Memory cache                                         │
│  • IndexedDB cache                                     │
│  • Service Worker cache                                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         Retry Middleware Layer                           │
│  • Exponential backoff                                  │
│  • Circuit breaker                                      │
│  • Request queuing                                      │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         Strategy Execution Layer                         │
│  1. Proxy (Background Worker)                           │
│  2. Redirect (URL Conversion)                           │
│  3. Alternative Protocols                               │
│  4. Fallback Content                                    │
└─────────────────────────────────────────────────────────┘
```

---

## Next Steps

1. Implement JavaScript event middleware (Priority 3)
2. Add resource caching (Priority 4)
3. Implement retry logic (Priority 5)
4. Add request queuing (Priority 6)
5. Enhance error recovery (Priority 10)

