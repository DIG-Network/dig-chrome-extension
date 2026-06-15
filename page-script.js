// Page script that runs in the page context (not isolated world)
// This intercepts dig:// URLs before the browser tries to load them

(function() {
  'use strict';
  
  // Debug: Log that page script is running
  console.log('DIG Extension: Page script loaded at', new Date().toISOString());
  
  // Cache for RPC host configuration
  let cachedRpcHost = 'localhost:80';

  // Capture the real postMessage BEFORE our later override replaces it.
  // digProxyFetch must use this so the dig:// URL in the request payload is
  // not mangled by the postMessage override that converts dig:// string values.
  const _origPostMessage = window.postMessage.bind(window);

  // Pending proxy requests keyed by id → { resolve, reject, timer }
  const _digProxyPending = new Map();

  // Listen for DIG_PROXY_RESPONSE from the content-script bridge.
  // We register this listener once at page-script load time.
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'DIG_PROXY_RESPONSE') return;
    const { id, dataUrl, contentType, error } = event.data;
    const pending = _digProxyPending.get(id);
    if (!pending) return;
    _digProxyPending.delete(id);
    clearTimeout(pending.timer);
    if (error) {
      pending.reject(new Error('DIG proxy: ' + error));
    } else {
      pending.resolve({ dataUrl, contentType });
    }
  });

  /**
   * Ask the content-script bridge (→ background SW → rpc.dig.net) to fetch a
   * dig:// URL and return { dataUrl, contentType }.  Rejects on error or timeout.
   */
  function digProxyFetch(url) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const timer = setTimeout(() => {
        _digProxyPending.delete(id);
        reject(new Error('DIG proxy timeout for ' + url));
      }, 30000);
      _digProxyPending.set(id, { resolve, reject, timer });
      // Use the pre-override postMessage so the url field is not rewritten
      _origPostMessage({ type: 'DIG_PROXY_REQUEST', id, url }, '*');
    });
  }

  // Get RPC host from storage via message to background script
  function updateRpcHostCache() {
    // Page scripts can't directly access chrome.storage, so we'll use a message
    // For now, we'll use a default and let the content script handle updates
    // The content script will inject the current RPC host if needed
    try {
      // Prioritize data attribute (most CSP-safe)
      if (document.documentElement) {
        const dataHost = document.documentElement.getAttribute('data-dig-rpc-host');
        if (dataHost) {
          cachedRpcHost = dataHost;
          return; // Data attribute takes precedence
        }
      }
      // Fallback to window property (may be blocked by CSP)
      if (window.__DIG_RPC_HOST__) {
        cachedRpcHost = window.__DIG_RPC_HOST__;
      }
    } catch (e) {
      // Ignore
    }
  }
  
  // Initialize cache
  updateRpcHostCache();
  
  // Listen for updates from content script via custom event
  window.addEventListener('dig-rpc-host-updated', (event) => {
    if (event.detail && event.detail.rpcHost) {
      cachedRpcHost = event.detail.rpcHost;
    }
  });
  
  // Also listen for postMessage (CSP-safe alternative)
  window.addEventListener('message', (event) => {
    // Only accept messages from same origin or extension context
    if (event.data && event.data.type === 'dig-rpc-host-updated' && event.data.rpcHost) {
      cachedRpcHost = event.data.rpcHost;
      // Also update from data attribute if available
      updateRpcHostCache();
    }
  });
  
  // Periodically check data attribute for updates (fallback)
  setInterval(() => {
    updateRpcHostCache();
  }, 1000);
  
  // Suppress console errors for dig:// scheme errors
  const originalConsoleError = console.error;
  console.error = function(...args) {
    const message = args.join(' ');
    // Filter out dig:// scheme errors
    if (message.includes('dig://') && (
      message.includes('ERR_UNKNOWN_URL_SCHEME') ||
      message.includes('scheme does not have a registered handler') ||
      message.includes('not supported')
    )) {
      // Suppress these errors
      return;
    }
    originalConsoleError.apply(console, args);
  };
  
  // Suppress uncaught errors related to dig://
  const originalOnError = window.onerror;
  window.onerror = function(message, source, lineno, colno, error) {
    if (typeof message === 'string' && message.includes('dig://') && (
      message.includes('ERR_UNKNOWN_URL_SCHEME') ||
      message.includes('scheme does not have a registered handler') ||
      message.includes('not supported')
    )) {
      // Suppress these errors
      return true; // Prevent default error handling
    }
    if (originalOnError) {
      return originalOnError.call(this, message, source, lineno, colno, error);
    }
    return false;
  };
  
  // Also suppress unhandled promise rejections for dig://
  window.addEventListener('unhandledrejection', function(event) {
    const reason = event.reason;
    if (reason && typeof reason === 'object' && reason.message) {
      const message = reason.message;
      if (message.includes('dig://') && (
        message.includes('ERR_UNKNOWN_URL_SCHEME') ||
        message.includes('scheme does not have a registered handler') ||
        message.includes('not supported')
      )) {
        event.preventDefault(); // Suppress the error
      }
    }
  });
  
  // Convert dig:// URL - ALL dig:// URLs now use RPC via background script
  // This function returns a placeholder that will be replaced by proxyResource
  function convertDigUrl(url) {
    if (typeof url === 'string' && url.startsWith('dig://')) {
      // Return a placeholder data URL - actual fetching will be done via proxyResource
      // This prevents browser errors while proxy loads content via RPC
      return `data:application/octet-stream;base64,`; // Empty placeholder
    }
    return url;
  }
  
  // Process style tags IMMEDIATELY - before anything else
  // This must run synchronously to catch CSS before browser parses it
  (function processStyleTagsEarly() {
    if (document.head) {
      const styleTags = document.head.querySelectorAll('style');
      styleTags.forEach((style) => {
        if (style.textContent && style.textContent.includes('dig://')) {
          let newContent = style.textContent;
          
          // Convert @import statements with dig:// URLs
          newContent = newContent.replace(/@import\s+(?:url\()?['"]?(dig:\/\/[^'")]+)['"]?\)?;?/gi, (match, url) => {
            const convertedUrl = convertDigUrl(url);
            if (match.includes('url(')) {
              return match.replace(url, convertedUrl);
            } else {
              return `@import url('${convertedUrl}');`;
            }
          });
          
          // Convert url() functions with dig:// URLs (including background-image)
          newContent = newContent.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (match, url) => {
            return `url('${convertDigUrl(url)}')`;
          });
          
          // Convert @font-face src with dig:// URLs
          newContent = newContent.replace(/@font-face\s*\{[^}]*src\s*:\s*url\(['"]?(dig:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
            return match.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
              return `url('${convertDigUrl(url)}')`;
            });
          });
          
          // Convert @keyframes with dig:// URLs
          newContent = newContent.replace(/@keyframes\s+\w+\s*\{[^}]*url\(['"]?(dig:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
            return match.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
              return `url('${convertDigUrl(url)}')`;
            });
          });
          
          // Convert @property with dig:// URLs
          newContent = newContent.replace(/@property\s+[^\{]+\{[^}]*url\(['"]?(dig:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
            return match.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
              return `url('${convertDigUrl(url)}')`;
            });
          });
          
          // Convert @layer with dig:// URLs (unlikely but possible)
          newContent = newContent.replace(/@layer[^\{]*\{[^}]*url\(['"]?(dig:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
            return match.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
              return `url('${convertDigUrl(url)}')`;
            });
          });
          
          // Convert @container with dig:// URLs (unlikely but possible)
          newContent = newContent.replace(/@container[^\{]*\{[^}]*url\(['"]?(dig:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
            return match.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
              return `url('${convertDigUrl(url)}')`;
            });
          });
          
          // Convert @scope with dig:// URLs
          newContent = newContent.replace(/@scope[^\{]*\{[^}]*url\(['"]?(dig:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
            return match.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
              return `url('${convertDigUrl(url)}')`;
            });
          });
          
          // Convert @font-palette-values with dig:// URLs
          newContent = newContent.replace(/@font-palette-values[^\{]*\{[^}]*url\(['"]?(dig:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
            return match.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
              return `url('${convertDigUrl(url)}')`;
            });
          });
          
          // Convert CSS custom properties (CSS variables) with dig:// URLs
          newContent = newContent.replace(/(--[^:]+):\s*url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (match, prop, url) => {
            return `${prop}: url('${convertDigUrl(url)}')`;
          });
          
          if (newContent !== style.textContent) {
            style.textContent = newContent;
          }
        }
      });
    }
  })();
  
  // Override native methods to intercept dig:// URLs
  const originalCreateElement = document.createElement;
  document.createElement = function(tagName, options) {
    const element = originalCreateElement.call(this, tagName, options);
    
    // Intercept src/href attributes when they're set
    // But skip href for <a> tags - we intercept clicks instead
    const originalSetAttribute = element.setAttribute;
    element.setAttribute = function(name, value) {
      // Don't rewrite href for <a> tags - let click interception handle it
      if (name === 'href' && this.tagName === 'A' && typeof value === 'string' && value.startsWith('dig://')) {
        // Keep the dig:// URL as-is, don't convert it
        return originalSetAttribute.call(this, name, value);
      }
      
      // Convert dig:// URLs immediately to prevent ERR_UNKNOWN_URL_SCHEME errors
      // Content script can still intercept and proxy if needed
      if (name === 'srcset' && typeof value === 'string' && value.includes('dig://')) {
        value = value.replace(/dig:\/\/[^\s,]+/g, (match) => convertDigUrl(match));
      } else if (name === 'style' && typeof value === 'string' && value.includes('dig://')) {
        value = value.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (match, url) => {
          return `url(${convertDigUrl(url)})`;
        });
      } else if ((name === 'src' || name === 'href' || name === 'data') && typeof value === 'string' && value.startsWith('dig://')) {
        // Convert immediately to prevent browser errors
        // Content script can still proxy localhost URLs if needed
        value = convertDigUrl(value);
      }
      return originalSetAttribute.call(this, name, value);
    };
    
    // Intercept property setters for common attributes
    // But skip href for <a> tags - we intercept clicks instead
    const props = ['src', 'href', 'data', 'srcset'];
    props.forEach(prop => {
      try {
        Object.defineProperty(element, prop, {
          set: function(value) {
            // Don't rewrite href for <a> tags - let click interception handle it
            if (prop === 'href' && this.tagName === 'A' && typeof value === 'string' && value.startsWith('dig://')) {
              // Keep the dig:// URL as-is, don't convert it
              this.setAttribute(prop, value);
              return;
            }
            
            if (typeof value === 'string') {
              // Convert dig:// URLs immediately to prevent ERR_UNKNOWN_URL_SCHEME errors
              if (prop === 'srcset' && value.includes('dig://')) {
                value = value.replace(/dig:\/\/[^\s,]+/g, (match) => convertDigUrl(match));
              } else if ((prop === 'src' || prop === 'href' || prop === 'data') && value.startsWith('dig://')) {
                value = convertDigUrl(value);
              }
            }
            this.setAttribute(prop, value);
          },
          get: function() {
            return this.getAttribute(prop);
          },
          configurable: true
        });
      } catch (e) {
        // Some properties might not be configurable, ignore
      }
    });
    
    return element;
  };
  
  // Process existing elements - more aggressive
  function processExistingElements() {
    // Process all elements, not just specific tags
    const allElements = document.querySelectorAll('*');
    let processedCount = 0;
    allElements.forEach((element) => {
      // Skip <a> tags - we intercept clicks instead of rewriting href
      if (element.tagName === 'A') {
        return;
      }
      
      // Process src attribute - convert immediately to prevent ERR_UNKNOWN_URL_SCHEME
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('dig://')) {
        element.setAttribute('src', convertDigUrl(srcAttr));
      }
      
      // Process href attribute (but not for <a> tags)
      const hrefAttr = element.getAttribute('href');
      if (hrefAttr && hrefAttr.startsWith('dig://')) {
        // Convert all href attributes immediately
        element.setAttribute('href', convertDigUrl(hrefAttr));
      }
      
      // Process data attribute
      const dataAttr = element.getAttribute('data');
      if (dataAttr && dataAttr.startsWith('dig://')) {
        element.setAttribute('data', convertDigUrl(dataAttr));
      }
      
      // Process srcset attribute
      const srcsetAttr = element.getAttribute('srcset');
      if (srcsetAttr && srcsetAttr.includes('dig://')) {
        element.setAttribute('srcset', srcsetAttr.replace(/dig:\/\/[^\s,]+/g, (match) => convertDigUrl(match)));
      }
      
      // Process inline styles
      const styleAttr = element.getAttribute('style');
      if (styleAttr && styleAttr.includes('dig://')) {
        const newStyle = styleAttr.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (match, url) => {
          return `url(${convertDigUrl(url)})`;
        });
        if (newStyle !== styleAttr) {
          element.setAttribute('style', newStyle);
        }
      }
      
      // Process SVG elements
      if (element.tagName === 'USE' || element.tagName === 'use') {
        const svgHref = element.getAttribute('href') || element.getAttribute('xlink:href');
        if (svgHref && svgHref.startsWith('dig://')) {
          element.setAttribute('href', convertDigUrl(svgHref));
          if (element.hasAttribute('xlink:href')) {
            element.setAttribute('xlink:href', convertDigUrl(svgHref));
          }
        }
      }
      if (element.tagName === 'IMAGE' || element.tagName === 'image') {
        const svgHref = element.getAttribute('href') || element.getAttribute('xlink:href');
        if (svgHref && svgHref.startsWith('dig://')) {
          element.setAttribute('href', convertDigUrl(svgHref));
          if (element.hasAttribute('xlink:href')) {
            element.setAttribute('xlink:href', convertDigUrl(svgHref));
          }
        }
      }
      
      // Process form elements
      if (element.tagName === 'FORM') {
        const action = element.getAttribute('action');
        if (action && action.startsWith('dig://')) {
          element.setAttribute('action', convertDigUrl(action));
        }
      }
      if (element.tagName === 'INPUT' || element.tagName === 'BUTTON') {
        const formaction = element.getAttribute('formaction');
        if (formaction && formaction.startsWith('dig://')) {
          element.setAttribute('formaction', convertDigUrl(formaction));
        }
      }
      
      // Process meta tags
      if (element.tagName === 'META') {
        const property = element.getAttribute('property') || element.getAttribute('name');
        const content = element.getAttribute('content');
        if (content && content.startsWith('dig://') && 
            (property === 'og:image' || property === 'og:image:url' || 
             property === 'twitter:image' || property === 'twitter:image:src' ||
             property === 'image' || property === 'thumbnail')) {
          element.setAttribute('content', convertDigUrl(content));
        }
      }
      
      // Count if we processed this element
      if (srcAttr || hrefAttr || dataAttr || srcsetAttr || styleAttr) {
        processedCount++;
      }
    });
    
    console.log(`DIG Extension (page script): Processed ${processedCount} elements`);
    
    // Process style tags - handle both @import and url()
    const styleTags = document.querySelectorAll('style');
    styleTags.forEach((style) => {
      if (style.textContent && style.textContent.includes('dig://')) {
        let newContent = style.textContent;
        
        // Convert @import statements with dig:// URLs
        // Matches: @import url('dig://...'); or @import 'dig://...';
        newContent = newContent.replace(/@import\s+(?:url\()?['"]?(dig:\/\/[^'")]+)['"]?\)?;?/gi, (match, url) => {
          const convertedUrl = convertDigUrl(url);
          // Preserve the format (url() or plain string)
          if (match.includes('url(')) {
            return match.replace(url, convertedUrl);
          } else {
            return `@import url('${convertedUrl}');`;
          }
        });
        
          // Convert url() functions with dig:// URLs - preserve quote style
          newContent = newContent.replace(/url\((['"]?)(dig:\/\/[^'")]+)\1\)/gi, (match, quote, url) => {
            const convertedUrl = convertDigUrl(url);
            // Use single quotes for consistency
            return `url('${convertedUrl}')`;
          });
          
          // Convert @font-face src with dig:// URLs
          newContent = newContent.replace(/@font-face\s*\{[^}]*src\s*:\s*url\(['"]?(dig:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
            return match.replace(/url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
              return `url('${convertDigUrl(url)}')`;
            });
          });
          
          // Convert CSS custom properties (CSS variables) with dig:// URLs
          newContent = newContent.replace(/(--[^:]+):\s*url\(['"]?(dig:\/\/[^'")]+)['"]?\)/gi, (match, prop, url) => {
            return `${prop}: url('${convertDigUrl(url)}')`;
          });
        
        if (newContent !== style.textContent) {
          style.textContent = newContent;
        }
      }
    });
    
    // Process link tags with href (but not <a> tags - those are handled by click interception)
    const linkTags = document.querySelectorAll('link[href]');
    linkTags.forEach((link) => {
      const href = link.getAttribute('href');
      if (href && href.startsWith('dig://')) {
        link.setAttribute('href', convertDigUrl(href));
      }
    });
  }
  
  // Track if initial processing is complete
  let initialProcessingComplete = false;
  
  // Process immediately - don't wait for anything
  function runImmediately() {
    if (initialProcessingComplete) return; // Only process once
    
    // Process existing elements right now
    if (document.documentElement) {
      processExistingElements();
    }
  }
  
  // Run immediately - this is critical for catching resources before they load
  // Use requestAnimationFrame to ensure we run as early as possible but after DOM is available
  if (document.documentElement) {
    runImmediately();
  } else {
    // If documentElement doesn't exist yet, wait for it
    const checkDocument = setInterval(() => {
      if (document.documentElement) {
        clearInterval(checkDocument);
        runImmediately();
      }
    }, 0);
    // Safety timeout
    setTimeout(() => clearInterval(checkDocument), 1000);
  }
  
  // Check if we missed resources and need to reload (only once)
  function checkForMissedResources() {
    // Use sessionStorage to prevent infinite reload loops
    const reloadKey = 'dig-extension-reloaded';
    if (sessionStorage.getItem(reloadKey)) {
      return; // Already reloaded once, don't reload again
    }
    
    // Check if there are any unconverted dig:// URLs
    const hasUnconverted = document.querySelectorAll(
      'img[src^="dig://"], script[src^="dig://"], link[href^="dig://"], ' +
      'source[src^="dig://"], video[src^="dig://"], audio[src^="dig://"], ' +
      'iframe[src^="dig://"], object[data^="dig://"], embed[data^="dig://"]'
    ).length > 0;
    
    if (hasUnconverted && document.readyState === 'complete') {
      // Mark that we're reloading and reload once
      sessionStorage.setItem(reloadKey, 'true');
      console.log('DIG Extension (page script): Detected missed resources, reloading page once...');
      window.location.reload();
    }
  }
  
  // Process once more when DOM is ready, then stop
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        if (!initialProcessingComplete) {
          runImmediately();
          initialProcessingComplete = true;
        }
        // Check for missed resources after processing
        checkForMissedResources();
      }, 50);
    }, { once: true });
  } else {
    setTimeout(() => {
      if (!initialProcessingComplete) {
        runImmediately();
        initialProcessingComplete = true;
      }
      // Check for missed resources after processing
      checkForMissedResources();
    }, 50);
  }
  
  // Also check when page is fully loaded
  if (document.readyState === 'complete') {
    setTimeout(checkForMissedResources, 200);
  } else {
    window.addEventListener('load', () => {
      setTimeout(checkForMissedResources, 200);
    }, { once: true });
  }
  
  // Intercept window.location.href assignments for programmatic navigation
  // This must be done VERY EARLY, before any scripts try to use it
  // Move this to the very top of the script execution
  (function interceptLocationEarly() {
    const originalLocation = window.location;
    
    // Helper to navigate via background script (most reliable)
    function navigateViaExtension(digUrl) {
      const localhostUrl = convertDigUrl(digUrl);
      
      // Try multiple methods to ensure navigation works
      // Method 1: Use replace() (most reliable, doesn't add to history)
      try {
        // Get the original replace function before we override it
        const originalReplace = window.location.replace.bind(window.location);
        originalReplace(localhostUrl);
        return;
      } catch (e) {
        // Continue to next method
      }
      
      // Method 2: Use assign()
      try {
        const originalAssign = window.location.assign.bind(window.location);
        originalAssign(localhostUrl);
        return;
      } catch (e) {
        // Continue to next method
      }
      
      // Method 3: Post message to content script to use chrome.tabs.update (most reliable)
      try {
        window.postMessage({
          type: 'dig-navigate',
          url: digUrl
        }, window.location.origin);
        // Don't return - let it also try direct navigation as immediate fallback
        // The content script will handle the postMessage and use chrome.tabs.update
      } catch (e) {
        // Continue to last resort
      }
      
      // Last resort: direct href assignment (may fail but worth trying)
      try {
        window.location.href = localhostUrl;
      } catch (e) {
        console.warn('DIG Extension: All navigation methods failed for', digUrl);
      }
    }
    
    // Try to override location.href setter directly (most reliable method)
    try {
      const hrefDescriptor = Object.getOwnPropertyDescriptor(originalLocation, 'href') ||
                             Object.getOwnPropertyDescriptor(Object.getPrototypeOf(originalLocation), 'href') ||
                             Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      
      // Only try to redefine if the property is configurable
      if (hrefDescriptor && hrefDescriptor.set && hrefDescriptor.configurable) {
        // Store the original setter
        const originalHrefSetter = hrefDescriptor.set;
        
        Object.defineProperty(originalLocation, 'href', {
          get: function() {
            return hrefDescriptor.get ? hrefDescriptor.get.call(this) : originalLocation.href;
          },
          set: function(value) {
            if (typeof value === 'string' && value.startsWith('dig://')) {
              // Use replace() instead of setter to avoid recursion
              navigateViaExtension(value);
            } else {
              // For non-dig:// URLs, use original setter
              originalHrefSetter.call(originalLocation, value);
            }
          },
          configurable: true,
          enumerable: true
        });
      } else {
        // Fallback: override Location.prototype.href
        try {
          const protoDescriptor = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
          // Only try to redefine if the property is configurable
          if (protoDescriptor && protoDescriptor.set && protoDescriptor.configurable) {
            const originalProtoSetter = protoDescriptor.set;
            Object.defineProperty(Location.prototype, 'href', {
              get: function() {
                return protoDescriptor.get ? protoDescriptor.get.call(this) : this.toString();
              },
              set: function(value) {
                if (typeof value === 'string' && value.startsWith('dig://')) {
                  navigateViaExtension(value);
                } else {
                  originalProtoSetter.call(this, value);
                }
              },
              configurable: true,
              enumerable: true
            });
          }
        } catch (e) {
          // If that fails, try overriding window.location itself
          try {
            const locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
            if (locationDescriptor && locationDescriptor.configurable) {
              let locationValue = originalLocation;
              Object.defineProperty(window, 'location', {
                get: function() {
                  return locationValue;
                },
                set: function(value) {
                  if (typeof value === 'string' && value.startsWith('dig://')) {
                    navigateViaExtension(value);
                  } else {
                    locationValue.href = value;
                  }
                },
                configurable: true
              });
            }
          } catch (e2) {
            console.warn('DIG Extension: Could not intercept window.location, programmatic navigation may not work');
          }
        }
      }
    } catch (e) {
      console.warn('DIG Extension: Could not intercept location.href setter', e);
    }
  })();
  
  // Also intercept window.location.replace and window.location.assign
  // These are read-only, so we need to wrap them differently
  try {
    const originalReplace = window.location.replace.bind(window.location);
    Object.defineProperty(window.location, 'replace', {
      value: function(url) {
        if (typeof url === 'string' && url.startsWith('dig://')) {
          url = convertDigUrl(url);
        }
        return originalReplace(url);
      },
      writable: false,
      configurable: true
    });
  } catch (e) {
    // If we can't override replace, that's okay - href setter should handle it
  }
  
  try {
    const originalAssign = window.location.assign.bind(window.location);
    Object.defineProperty(window.location, 'assign', {
      value: function(url) {
        if (typeof url === 'string' && url.startsWith('dig://')) {
          url = convertDigUrl(url);
        }
        return originalAssign(url);
      },
      writable: false,
      configurable: true
    });
  } catch (e) {
    // If we can't override assign, that's okay - href setter should handle it
  }
  
  // Intercept fetch API in page context — route dig:// through the content-script bridge
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    let url = args[0];
    let isDigUrl = false;

    if (typeof url === 'string' && url.startsWith('dig://')) {
      isDigUrl = true;
    } else if (url instanceof Request && url.url.startsWith('dig://')) {
      isDigUrl = true;
      url = url.url;
    }

    if (isDigUrl) {
      // Route through content-script → background → rpc.dig.net to get real decrypted bytes
      try {
        const { dataUrl, contentType } = await digProxyFetch(url);
        // data: URLs are fetchable in-page — fetch it to get a proper Response
        const dataResponse = await originalFetch.call(this, dataUrl);
        // Re-wrap with the correct Content-Type header
        const blob = await dataResponse.blob();
        return new Response(blob, {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': contentType || 'application/octet-stream' },
        });
      } catch (proxyErr) {
        console.warn('DIG Extension (page): fetch proxy failed for', url, proxyErr);
        // Reject — do NOT silently return empty content
        throw proxyErr;
      }
    }

    return originalFetch.apply(this, args);
  };
  
  // Intercept dynamic import() statements
  // Note: This is a best-effort approach since import() is a language feature
  // We intercept it by wrapping the global import function if possible
  if (window.import) {
    const originalImport = window.import;
    window.import = function(moduleSpecifier) {
      if (typeof moduleSpecifier === 'string' && moduleSpecifier.startsWith('dig://')) {
        moduleSpecifier = convertDigUrl(moduleSpecifier);
      }
      return originalImport.call(this, moduleSpecifier);
    };
  }
  
  // For ES6 import statements in <script type="module">, we need to intercept at the script level
  // This is handled by the content script processing script tags
  // But we can also try to intercept import.meta.url if needed
  if (window.importMetaResolve) {
    const originalImportMetaResolve = window.importMetaResolve;
    window.importMetaResolve = function(specifier, parent) {
      if (typeof specifier === 'string' && specifier.startsWith('dig://')) {
        specifier = convertDigUrl(specifier);
      }
      return originalImportMetaResolve.call(this, specifier, parent);
    };
  }
  
  // Intercept History API (pushState, replaceState) for dig:// URLs
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(state, title, url) {
    if (typeof url === 'string' && url.startsWith('dig://')) {
      url = convertDigUrl(url);
    }
    return originalPushState.call(this, state, title, url);
  };
  
  history.replaceState = function(state, title, url) {
    if (typeof url === 'string' && url.startsWith('dig://')) {
      url = convertDigUrl(url);
    }
    return originalReplaceState.call(this, state, title, url);
  };
  
  // Intercept Beacon API (navigator.sendBeacon)
  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
      if (typeof url === 'string' && url.startsWith('dig://')) {
        url = convertDigUrl(url);
      }
      return originalSendBeacon.call(this, url, data);
    };
  }
  
  // Intercept FileReader API (readAsDataURL, readAsArrayBuffer, etc.)
  if (window.FileReader) {
    const originalFileReader = window.FileReader;
    // Note: FileReader typically works with File/Blob objects, not URLs
    // But we intercept if someone tries to use dig:// URLs with it
    window.FileReader = function() {
      const reader = new originalFileReader();
      const originalReadAsDataURL = reader.readAsDataURL;
      const originalReadAsArrayBuffer = reader.readAsArrayBuffer;
      const originalReadAsText = reader.readAsText;
      
      reader.readAsDataURL = function(blob) {
        // If blob is actually a dig:// URL string, fetch it first
        if (typeof blob === 'string' && blob.startsWith('dig://')) {
          fetch(convertDigUrl(blob))
            .then(r => r.blob())
            .then(b => originalReadAsDataURL.call(this, b))
            .catch(err => console.warn('DIG Extension: FileReader failed', err));
          return;
        }
        return originalReadAsDataURL.call(this, blob);
      };
      
      reader.readAsArrayBuffer = function(blob) {
        if (typeof blob === 'string' && blob.startsWith('dig://')) {
          fetch(convertDigUrl(blob))
            .then(r => r.blob())
            .then(b => originalReadAsArrayBuffer.call(this, b))
            .catch(err => console.warn('DIG Extension: FileReader failed', err));
          return;
        }
        return originalReadAsArrayBuffer.call(this, blob);
      };
      
      reader.readAsText = function(blob, encoding) {
        if (typeof blob === 'string' && blob.startsWith('dig://')) {
          fetch(convertDigUrl(blob))
            .then(r => r.blob())
            .then(b => originalReadAsText.call(this, b, encoding))
            .catch(err => console.warn('DIG Extension: FileReader failed', err));
          return;
        }
        return originalReadAsText.call(this, blob, encoding);
      };
      
      return reader;
    };
  }
  
  // Intercept Web Animations API (Element.animate)
  if (Element.prototype.animate) {
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = function(keyframes, options) {
      // Check if keyframes contain dig:// URLs in background-image or similar
      if (Array.isArray(keyframes)) {
        keyframes = keyframes.map(kf => {
          if (kf && typeof kf === 'object') {
            const newKf = { ...kf };
            Object.keys(newKf).forEach(prop => {
              if (typeof newKf[prop] === 'string' && newKf[prop].includes('dig://')) {
                newKf[prop] = newKf[prop].replace(/dig:\/\/[^\s'")]+/g, (match) => convertDigUrl(match));
              }
            });
            return newKf;
          }
          return kf;
        });
      } else if (keyframes && typeof keyframes === 'object') {
        const newKeyframes = { ...keyframes };
        Object.keys(newKeyframes).forEach(prop => {
          if (typeof newKeyframes[prop] === 'string' && newKeyframes[prop].includes('dig://')) {
            newKeyframes[prop] = newKeyframes[prop].replace(/dig:\/\/[^\s'")]+/g, (match) => convertDigUrl(match));
          }
        });
        keyframes = newKeyframes;
      }
      return originalAnimate.call(this, keyframes, options);
    };
  }
  
  // Intercept Service Worker registration
  if ('serviceWorker' in navigator) {
    const originalRegister = navigator.serviceWorker.register;
    navigator.serviceWorker.register = function(scriptURL, options) {
      if (typeof scriptURL === 'string' && scriptURL.startsWith('dig://')) {
        scriptURL = convertDigUrl(scriptURL);
      }
      return originalRegister.call(this, scriptURL, options);
    };
  }
  
  // Intercept CSS.supports() for dig:// URLs (unlikely but possible)
  if (window.CSS && CSS.supports) {
    const originalSupports = CSS.supports;
    CSS.supports = function(property, value) {
      if (typeof value === 'string' && value.includes('dig://')) {
        value = value.replace(/dig:\/\/[^\s'")]+/g, (match) => convertDigUrl(match));
      }
      return originalSupports.call(this, property, value);
    };
  }
  
  // Intercept CSS Typed OM (if available)
  if (window.CSSStyleValue) {
    // CSSStyleValue is the base class, but we intercept URLValue specifically
    // This is advanced and may not be widely supported
    try {
      if (CSS.URL) {
        const originalURL = CSS.URL;
        CSS.URL = function(url) {
          if (typeof url === 'string' && url.startsWith('dig://')) {
            url = convertDigUrl(url);
          }
          return new originalURL(url);
        };
      }
    } catch (e) {
      // CSS Typed OM may not be available
    }
  }
  
  // Intercept Web Share API (navigator.share)
  if (navigator.share) {
    const originalShare = navigator.share;
    navigator.share = function(data) {
      if (data && data.url && typeof data.url === 'string' && data.url.startsWith('dig://')) {
        data = { ...data, url: convertDigUrl(data.url) };
      }
      return originalShare.call(this, data);
    };
  }
  
  // Intercept Broadcast Channel API (for cross-tab communication)
  if (window.BroadcastChannel) {
    const originalBroadcastChannel = window.BroadcastChannel;
    // Note: BroadcastChannel name is not a URL, but we check anyway
    window.BroadcastChannel = function(name) {
      if (typeof name === 'string' && name.startsWith('dig://')) {
        name = convertDigUrl(name);
      }
      return new originalBroadcastChannel(name);
    };
  }
  
  // Intercept Message Channel API (for cross-context communication)
  // Note: MessageChannel doesn't use URLs, but we intercept postMessage with dig:// URLs
  const originalPostMessage = window.postMessage;
  window.postMessage = function(message, targetOrigin, transfer) {
    // If message contains dig:// URLs, convert them
    if (message && typeof message === 'object') {
      const convertedMessage = JSON.parse(JSON.stringify(message, (key, value) => {
        if (typeof value === 'string' && value.startsWith('dig://')) {
          return convertDigUrl(value);
        }
        return value;
      }));
      return originalPostMessage.call(this, convertedMessage, targetOrigin, transfer);
    }
    return originalPostMessage.call(this, message, targetOrigin, transfer);
  };
  
  // Intercept Intersection Observer (for lazy loading with dig:// URLs)
  if (window.IntersectionObserver) {
    const originalIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver = function(callback, options) {
      // Wrap callback to convert any dig:// URLs in observed elements
      const wrappedCallback = function(entries, observer) {
        entries.forEach(entry => {
          if (entry.target) {
            // Process the target element if it has dig:// URLs
            const src = entry.target.src || entry.target.getAttribute('src');
            const href = entry.target.href || entry.target.getAttribute('href');
            if ((src && src.startsWith('dig://')) || (href && href.startsWith('dig://'))) {
              // Trigger content script processing
              window.dispatchEvent(new CustomEvent('dig-element-added', {
                detail: { element: entry.target }
              }));
            }
          }
        });
        return callback.call(this, entries, observer);
      };
      return new originalIntersectionObserver(wrappedCallback, options);
    };
  }
  
  // Intercept Clipboard API (navigator.clipboard.write, read)
  if (navigator.clipboard) {
    const originalWrite = navigator.clipboard.write;
    const originalRead = navigator.clipboard.read;
    
    if (originalWrite) {
      navigator.clipboard.write = async function(data) {
        // If data contains dig:// URLs, convert them
        if (data instanceof ClipboardItem) {
          // Handle ClipboardItem - convert any dig:// URLs in blob data
          const items = await Promise.all(
            data.types.map(async type => {
              const blob = await data.getType(type);
              // If blob is from a dig:// URL, we'd need to handle it differently
              // For now, just pass through
              return { type, blob };
            })
          );
          return originalWrite.call(this, data);
        }
        return originalWrite.call(this, data);
      };
    }
  }
  
  // Intercept Drag and Drop API - handle dataTransfer with dig:// URLs
  if (window.DataTransfer) {
    const originalSetData = DataTransfer.prototype.setData;
    DataTransfer.prototype.setData = function(format, data) {
      if (typeof data === 'string' && data.startsWith('dig://')) {
        data = convertDigUrl(data);
      }
      return originalSetData.call(this, format, data);
    };
    
    const originalGetData = DataTransfer.prototype.getData;
    DataTransfer.prototype.getData = function(format) {
      const data = originalGetData.call(this, format);
      // Note: We don't convert back, but we could if needed
      return data;
    };
  }
  
  // Intercept CSS Paint API (Houdini) - registerPaint with dig:// URLs
  if (window.CSS && CSS.paintWorklet) {
    const originalAddModule = CSS.paintWorklet.addModule;
    if (originalAddModule) {
      CSS.paintWorklet.addModule = function(moduleURL) {
        if (typeof moduleURL === 'string' && moduleURL.startsWith('dig://')) {
          moduleURL = convertDigUrl(moduleURL);
        }
        return originalAddModule.call(this, moduleURL);
      };
    }
  }
  
  // Intercept CSS Layout API (Houdini) - registerLayout with dig:// URLs
  if (window.CSS && CSS.layoutWorklet) {
    const originalAddModule = CSS.layoutWorklet.addModule;
    if (originalAddModule) {
      CSS.layoutWorklet.addModule = function(moduleURL) {
        if (typeof moduleURL === 'string' && moduleURL.startsWith('dig://')) {
          moduleURL = convertDigUrl(moduleURL);
        }
        return originalAddModule.call(this, moduleURL);
      };
    }
  }
  
  // Intercept CSS Animation Worklet API (Houdini)
  if (window.CSS && CSS.animationWorklet) {
    const originalAddModule = CSS.animationWorklet.addModule;
    if (originalAddModule) {
      CSS.animationWorklet.addModule = function(moduleURL) {
        if (typeof moduleURL === 'string' && moduleURL.startsWith('dig://')) {
          moduleURL = convertDigUrl(moduleURL);
        }
        return originalAddModule.call(this, moduleURL);
      };
    }
  }
  
  // Intercept WebCodecs API (VideoDecoder, AudioDecoder, ImageDecoder)
  if (window.VideoDecoder) {
    const originalVideoDecoder = window.VideoDecoder;
    window.VideoDecoder = function(init) {
      // If init contains dig:// URLs, convert them
      if (init && typeof init === 'object') {
        const newInit = { ...init };
        if (newInit.src && typeof newInit.src === 'string' && newInit.src.startsWith('dig://')) {
          newInit.src = convertDigUrl(newInit.src);
        }
        return new originalVideoDecoder(newInit);
      }
      return new originalVideoDecoder(init);
    };
  }
  
  if (window.AudioDecoder) {
    const originalAudioDecoder = window.AudioDecoder;
    window.AudioDecoder = function(init) {
      if (init && typeof init === 'object') {
        const newInit = { ...init };
        if (newInit.src && typeof newInit.src === 'string' && newInit.src.startsWith('dig://')) {
          newInit.src = convertDigUrl(newInit.src);
        }
        return new originalAudioDecoder(newInit);
      }
      return new originalAudioDecoder(init);
    };
  }
  
  if (window.ImageDecoder) {
    const originalImageDecoder = window.ImageDecoder;
    window.ImageDecoder = function(init) {
      if (init && typeof init === 'object') {
        const newInit = { ...init };
        if (newInit.src && typeof newInit.src === 'string' && newInit.src.startsWith('dig://')) {
          newInit.src = convertDigUrl(newInit.src);
        }
        if (newInit.data && typeof newInit.data === 'string' && newInit.data.startsWith('dig://')) {
          newInit.data = convertDigUrl(newInit.data);
        }
        return new originalImageDecoder(newInit);
      }
      return new originalImageDecoder(init);
    };
  }
  
  // Intercept WebTransport API
  if (window.WebTransport) {
    const originalWebTransport = window.WebTransport;
    window.WebTransport = function(url, options) {
      if (typeof url === 'string' && url.startsWith('dig://')) {
        url = convertDigUrl(url);
      }
      return new originalWebTransport(url, options);
    };
  }
  
  // Intercept WebAssembly streaming compilation — route dig:// via bridge
  if (window.WebAssembly && WebAssembly.compileStreaming) {
    const originalCompileStreaming = WebAssembly.compileStreaming;
    WebAssembly.compileStreaming = async function(source) {
      if (typeof source === 'string' && source.startsWith('dig://')) {
        try {
          const { dataUrl } = await digProxyFetch(source);
          source = originalFetch.call(window, dataUrl);
        } catch (err) {
          console.warn('DIG Extension (page): WebAssembly.compileStreaming proxy failed for', source, err);
          throw err;
        }
      } else if (source && typeof source.then === 'function') {
        source = source.then(response => {
          if (response.url && response.url.startsWith('dig://')) {
            return digProxyFetch(response.url).then(({ dataUrl }) => originalFetch.call(window, dataUrl));
          }
          return response;
        });
      }
      return originalCompileStreaming.call(this, source);
    };
  }

  // Second instantiateStreaming guard — already overridden above in the main WebAssembly block;
  // this guard is a no-op if the override already ran (WebAssembly.instantiateStreaming is the
  // version we installed), but kept for safety in case browser resets it between blocks.
  if (window.WebAssembly && WebAssembly.instantiateStreaming) {
    const _is = WebAssembly.instantiateStreaming;
    // Only re-wrap if it hasn't already been wrapped (check by name or sentinel)
    if (!_is._digWrapped) {
      const originalIS2 = _is;
      WebAssembly.instantiateStreaming = async function(source, importObject) {
        if (typeof source === 'string' && source.startsWith('dig://')) {
          try {
            const { dataUrl } = await digProxyFetch(source);
            const resp = await originalFetch.call(window, dataUrl);
            const buf = await resp.arrayBuffer();
            return WebAssembly.instantiate(buf, importObject);
          } catch (err) {
            console.warn('DIG Extension (page): WebAssembly.instantiateStreaming proxy failed for', source, err);
            throw err;
          }
        } else if (source && typeof source.then === 'function') {
          source = source.then(response => {
            if (response.url && response.url.startsWith('dig://')) {
              return digProxyFetch(response.url).then(({ dataUrl }) => originalFetch.call(window, dataUrl));
            }
            return response;
          });
        }
        return originalIS2.call(this, source, importObject);
      };
      WebAssembly.instantiateStreaming._digWrapped = true;
    }
  }
  
  // Intercept XMLHttpRequest in page context
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === 'string' && url.startsWith('dig://')) {
      url = convertDigUrl(url);
    }
    return originalXHROpen.call(this, method, url, ...rest);
  };
  
  // Intercept Image constructor in page context
  const originalImage = window.Image;
  window.Image = function(...args) {
    const img = new originalImage(...args);
    
    // If src is provided and it's a dig:// URL, convert it
    if (args.length > 0 && typeof args[0] === 'string' && args[0].startsWith('dig://')) {
      img.src = convertDigUrl(args[0]);
    } else if (img.src && img.src.startsWith('dig://')) {
      img.src = convertDigUrl(img.src);
    }
    
    return img;
  };
  
  // Intercept Worker constructor in page context
  // Workers cannot load data: URLs directly, but blob: URLs work fine.
  // We fetch the script via the bridge then construct a blob: URL.
  const originalWorker = window.Worker;
  window.Worker = function(scriptURL, options) {
    if (typeof scriptURL === 'string' && scriptURL.startsWith('dig://')) {
      // Return a synchronous-looking Worker by constructing a stub that
      // will load the real script once the proxy resolves.
      // Strategy: create a blob: URL asynchronously and forward all events.
      const digUrl = scriptURL;
      // Create a placeholder worker from an empty blob (will be replaced)
      // Instead, use a relay-worker pattern via a tiny inline blob worker:
      const relayBlob = new Blob([`
        self.onmessage = function(e) {
          if (e.data && e.data.__DIG_WORKER_SCRIPT__) {
            // Evaluate the real script source in this worker context
            try { eval(e.data.__DIG_WORKER_SCRIPT__); } catch(ex) { console.error('DIG worker eval failed', ex); }
          } else {
            // Forward to actual handler once script is loaded (handled above)
          }
        };
      `], { type: 'text/javascript' });
      const relayBlobUrl = URL.createObjectURL(relayBlob);
      const worker = new originalWorker(relayBlobUrl, options);
      URL.revokeObjectURL(relayBlobUrl);
      // Asynchronously fetch the real script and send it into the worker
      digProxyFetch(digUrl).then(({ dataUrl }) => {
        return originalFetch.call(window, dataUrl).then(r => r.text());
      }).then(scriptText => {
        worker.postMessage({ __DIG_WORKER_SCRIPT__: scriptText });
      }).catch(err => {
        console.warn('DIG Extension (page): Worker proxy failed for', digUrl, err);
      });
      return worker;
    }
    return new originalWorker(scriptURL, options);
  };
  
  // Intercept SharedWorker constructor in page context
  if (window.SharedWorker) {
    const originalSharedWorker = window.SharedWorker;
    window.SharedWorker = function(scriptURL, name, options) {
      // Convert dig:// URL to localhost before creating SharedWorker
      if (typeof scriptURL === 'string' && scriptURL.startsWith('dig://')) {
        scriptURL = convertDigUrl(scriptURL);
      }
      // SharedWorker constructor signature: (scriptURL, name?, options?)
      if (typeof name === 'string' && name.startsWith('dig://')) {
        // If name parameter is actually a dig:// URL (wrong usage), convert it
        name = convertDigUrl(name);
      }
      return new originalSharedWorker(scriptURL, name, options);
    };
  }
  
  // Intercept WebAssembly.instantiate and WebAssembly.instantiateStreaming
  if (window.WebAssembly) {
    const originalInstantiate = WebAssembly.instantiate;
    if (originalInstantiate) {
      WebAssembly.instantiate = async function(bufferSource, importObject) {
        // If bufferSource is a dig:// URL, fetch bytes via bridge
        if (typeof bufferSource === 'string' && bufferSource.startsWith('dig://')) {
          try {
            const { dataUrl } = await digProxyFetch(bufferSource);
            const resp = await originalFetch.call(window, dataUrl);
            bufferSource = await resp.arrayBuffer();
          } catch (err) {
            console.warn('DIG Extension (page): WebAssembly.instantiate proxy failed for', bufferSource, err);
            throw err;
          }
        }
        return originalInstantiate.call(this, bufferSource, importObject);
      };
    }

    const originalInstantiateStreaming = WebAssembly.instantiateStreaming;
    if (originalInstantiateStreaming) {
      WebAssembly.instantiateStreaming = async function(source, importObject) {
        // If source is a dig:// URL, fetch bytes via bridge and pass as ArrayBuffer
        if (typeof source === 'string' && source.startsWith('dig://')) {
          try {
            const { dataUrl } = await digProxyFetch(source);
            const resp = await originalFetch.call(window, dataUrl);
            const buf = await resp.arrayBuffer();
            // Fall through to WebAssembly.instantiate (not streaming) with real bytes
            return WebAssembly.instantiate(buf, importObject);
          } catch (err) {
            console.warn('DIG Extension (page): WebAssembly.instantiateStreaming proxy failed for', source, err);
            throw err;
          }
        } else if (source && typeof source.then === 'function') {
          source = source.then(response => {
            if (response.url && response.url.startsWith('dig://')) {
              return digProxyFetch(response.url).then(({ dataUrl }) => originalFetch.call(window, dataUrl));
            }
            return response;
          });
        }
        return originalInstantiateStreaming.call(this, source, importObject);
      };
      WebAssembly.instantiateStreaming._digWrapped = true;
    }
  }

  // Intercept Web Audio API - AudioContext.decodeAudioData
  if (window.AudioContext || window.webkitAudioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const originalDecodeAudioData = AudioContextClass.prototype.decodeAudioData;
    if (originalDecodeAudioData) {
      AudioContextClass.prototype.decodeAudioData = async function(audioData) {
        // If audioData is a dig:// URL string, fetch bytes via bridge
        if (typeof audioData === 'string' && audioData.startsWith('dig://')) {
          try {
            const { dataUrl } = await digProxyFetch(audioData);
            const response = await originalFetch.call(window, dataUrl);
            audioData = await response.arrayBuffer();
          } catch (err) {
            console.warn('DIG Extension (page): decodeAudioData proxy failed for', audioData, err);
            throw err;
          }
        }
        return originalDecodeAudioData.call(this, audioData);
      };
    }
  }

  // Intercept EventSource (Server-Sent Events) constructor
  // EventSource requires a real HTTP URL; dig:// SSE is not a realistic use-case but
  // we warn clearly rather than silently yielding an empty/broken stream.
  if (window.EventSource) {
    const originalEventSource = window.EventSource;
    window.EventSource = function(url, eventSourceInitDict) {
      if (typeof url === 'string' && url.startsWith('dig://')) {
        console.warn(
          'DIG Extension (page): EventSource with dig:// URL is not supported ' +
          '(SSE requires a live HTTP endpoint). URL:', url
        );
        // Fall through — browser will throw ERR_UNKNOWN_URL_SCHEME which is the correct signal
      }
      return new originalEventSource(url, eventSourceInitDict);
    };
  }
  
  // Intercept Canvas image sources (drawImage with dig:// URLs)
  if (window.HTMLCanvasElement) {
    const originalDrawImage = HTMLCanvasElement.prototype.drawImage;
    HTMLCanvasElement.prototype.drawImage = function(image, ...args) {
      // If image is a string URL starting with dig://, convert it
      if (typeof image === 'string' && image.startsWith('dig://')) {
        const img = new Image();
        img.src = convertDigUrl(image);
        // Wait for image to load, then draw
        img.onload = () => {
          originalDrawImage.call(this, img, ...args);
        };
        return;
      }
      return originalDrawImage.call(this, image, ...args);
    };
  }
  
  // Intercept WebGL texture loading
  if (window.WebGLRenderingContext || window.WebGL2RenderingContext) {
    const WebGLContext = window.WebGLRenderingContext || window.WebGL2RenderingContext;
    if (WebGLContext && WebGLContext.prototype) {
      const originalTexImage2D = WebGLContext.prototype.texImage2D;
      if (originalTexImage2D) {
        WebGLContext.prototype.texImage2D = function(...args) {
          // Check if any argument is a dig:// URL
          const convertedArgs = args.map(arg => {
            if (typeof arg === 'string' && arg.startsWith('dig://')) {
              // This would need to be handled differently - WebGL needs actual image data
              // For now, convert URL and let browser handle it
              return convertDigUrl(arg);
            }
            return arg;
          });
          return originalTexImage2D.apply(this, convertedArgs);
        };
      }
    }
  }
  
  // Override HTMLImageElement.prototype.src setter (Image instances are HTMLImageElement)
  // This is critical - it intercepts img.src = 'dig://...' assignments
  try {
    const originalImageSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    
    if (originalImageSrcDescriptor) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: function() {
          return originalImageSrcDescriptor.get ? originalImageSrcDescriptor.get.call(this) : this.getAttribute('src');
        },
        set: function(value) {
          // Convert dig:// URLs immediately to prevent ERR_UNKNOWN_URL_SCHEME errors
          if (typeof value === 'string' && value.startsWith('dig://')) {
            value = convertDigUrl(value);
          }
          if (originalImageSrcDescriptor.set) {
            originalImageSrcDescriptor.set.call(this, value);
          } else {
            this.setAttribute('src', value);
          }
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {
    // If we can't override HTMLImageElement.prototype.src, try Image.prototype
    try {
      const originalImageSrcDescriptor = Object.getOwnPropertyDescriptor(Image.prototype, 'src');
      if (originalImageSrcDescriptor && originalImageSrcDescriptor.configurable) {
        Object.defineProperty(Image.prototype, 'src', {
          get: function() {
            return originalImageSrcDescriptor.get ? originalImageSrcDescriptor.get.call(this) : this.getAttribute('src');
          },
          set: function(value) {
            // Convert dig:// URLs immediately to prevent ERR_UNKNOWN_URL_SCHEME errors
            if (typeof value === 'string' && value.startsWith('dig://')) {
              value = convertDigUrl(value);
            }
            if (originalImageSrcDescriptor.set) {
              originalImageSrcDescriptor.set.call(this, value);
            } else {
              this.setAttribute('src', value);
            }
          },
          configurable: true,
          enumerable: true
        });
      }
    } catch (e2) {
      console.warn('DIG Extension: Could not override Image src setter', e2);
    }
  }
  
  // Override HTMLVideoElement.prototype.src setter
  // This intercepts video.src = 'dig://...' assignments
  try {
    const originalVideoSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
    if (originalVideoSrcDescriptor && originalVideoSrcDescriptor.configurable) {
      Object.defineProperty(HTMLVideoElement.prototype, 'src', {
        get: function() {
          return originalVideoSrcDescriptor.get ? originalVideoSrcDescriptor.get.call(this) : this.getAttribute('src');
        },
        set: function(value) {
          // Convert dig:// URLs immediately to prevent ERR_UNKNOWN_URL_SCHEME errors
          if (typeof value === 'string' && value.startsWith('dig://')) {
            value = convertDigUrl(value);
          }
          if (originalVideoSrcDescriptor.set) {
            originalVideoSrcDescriptor.set.call(this, value);
          } else {
            this.setAttribute('src', value);
          }
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {
    console.warn('DIG Extension: Could not override Video src setter', e);
  }
  
  // Override HTMLAudioElement.prototype.src setter
  // This intercepts audio.src = 'dig://...' assignments
  try {
    const originalAudioSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLAudioElement.prototype, 'src');
    if (originalAudioSrcDescriptor && originalAudioSrcDescriptor.configurable) {
      Object.defineProperty(HTMLAudioElement.prototype, 'src', {
        get: function() {
          return originalAudioSrcDescriptor.get ? originalAudioSrcDescriptor.get.call(this) : this.getAttribute('src');
        },
        set: function(value) {
          // Convert dig:// URLs immediately to prevent ERR_UNKNOWN_URL_SCHEME errors
          if (typeof value === 'string' && value.startsWith('dig://')) {
            value = convertDigUrl(value);
          }
          if (originalAudioSrcDescriptor.set) {
            originalAudioSrcDescriptor.set.call(this, value);
          } else {
            this.setAttribute('src', value);
          }
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {
    console.warn('DIG Extension: Could not override Audio src setter', e);
  }
  
  // MutationObserver for dynamically added elements
  // This catches elements added after initial page load
  const mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) { // Element node
          // Process elements with dig:// URLs immediately
          const hasDigUrl = (
            (node.src && node.src.startsWith('dig://')) ||
            (node.href && node.href.startsWith('dig://')) ||
            (node.data && node.data.startsWith('dig://')) ||
            (node.getAttribute && (
              node.getAttribute('src')?.startsWith('dig://') ||
              node.getAttribute('href')?.startsWith('dig://') ||
              node.getAttribute('data')?.startsWith('dig://')
            ))
          );
          
          if (hasDigUrl) {
            // Trigger content script processing by dispatching a custom event
            // The content script will catch this and process the element
            window.dispatchEvent(new CustomEvent('dig-element-added', {
              detail: { element: node }
            }));
          }
        }
      });
    });
  });
  
  // Start observing when DOM is ready
  if (document.documentElement) {
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data']
    });
  }
})();

