// @ts-nocheck — Verbatim-moved (issue #68) MAIN-side content-script interception shim. This file's
// job is wholesale reassignment of native URL-consuming globals (fetch, XHR, createElement, element
// src/href setters, MutationObserver targets, …), a pattern TypeScript's structural DOM lib types
// cannot express, with `any` eslint-banned and `noImplicitAny` on. It is proven, behaviour-frozen
// code relocated unchanged — there is no bug to type away — so it is exempted from strict tsc here
// (the sibling middleware.ts stays fully typed). Fully strict-typing this shim is a tracked follow-up.
// Content script to intercept all chia:// protocol requests
// Handles: images, scripts, stylesheets, AJAX/fetch, and any other resource requests

// The hardened wallet-bridge primitives (#73) — esbuild inlines this pure module into content.js,
// so the bundled classic script stays self-contained. The wallet bridge (wireWalletBridge, below)
// is the ONLY consumer; the rest of this file is the chia:// resource-interception shim.
import { parseInboundRequest, buildResponse, postTargetOrigin } from '../lib/provider-channel';

// Suppress console errors for chia:// scheme errors in content script context
(function() {
  const originalConsoleError = console.error;
  console.error = function(...args) {
    const message = args.join(' ');
    // Filter out chia:// scheme errors
    if (message.includes('chia://') && (
      message.includes('ERR_UNKNOWN_URL_SCHEME') ||
      message.includes('scheme does not have a registered handler') ||
      message.includes('not supported')
    )) {
      // Suppress these errors
      return;
    }
    originalConsoleError.apply(console, args);
  };
})();

// Early detection: Check if we're on a Google search page with chia:// in URL
// This runs at document_start to catch it before Google's scripts load
(function() {
  'use strict';
  
  // Only run on main frame
  if (window.top !== window.self) {
    return;
  }
  
  // Check current URL for chia:// in search query
  try {
    const currentUrl = window.location.href;
    const searchEngines = ['google.com/search', 'www.google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
    const isSearchPage = searchEngines.some(engine => currentUrl.includes(engine));
    
    if (isSearchPage) {
      const urlObj = new URL(currentUrl);
      const queryParams = ['q', 'query', 'text', 'p', 'wd'];
      let query = null;
      
      for (const param of queryParams) {
        query = urlObj.searchParams.get(param);
        if (query) break;
      }
      
      if (query) {
        let digUrl = null;
        
        // Try multiple decoding passes (Google may double-encode)
        let decodedQuery = query;
        for (let i = 0; i < 3; i++) {
          // First try direct match
          const digMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
          if (digMatch) {
            digUrl = digMatch[0];
            break;
          }
          
          // Try URL-decoding
          try {
            const nextDecoded = decodeURIComponent(decodedQuery);
            if (nextDecoded === decodedQuery) {
              // No more decoding possible
              break;
            }
            decodedQuery = nextDecoded;
          } catch (e) {
            // Already decoded or invalid encoding
            break;
          }
        }
        
        // Final check on fully decoded query
        if (!digUrl) {
          const finalMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
          if (finalMatch) {
            digUrl = finalMatch[0];
          }
        }
        
        if (digUrl) {
          console.log('DIG Extension: Content script detected chia:// in search, redirecting:', digUrl);
          // Request background script to redirect immediately
          // Use setTimeout(0) to ensure this runs after any pending operations
          setTimeout(() => {
            chrome.runtime.sendMessage({
              action: 'navigateToDigUrl',
              url: digUrl
            }, (response) => {
              if (chrome.runtime.lastError) {
                // Ignore errors - navigation might have already happened
                if (!chrome.runtime.lastError.message.includes('message port closed')) {
                  console.error('DIG Extension: Error requesting redirect:', chrome.runtime.lastError);
                }
              }
            });
          }, 0);
          
          // Also try to stop page loading immediately
          try {
            if (document.readyState === 'loading') {
              // Stop any pending navigation
              window.stop();
            }
          } catch (e) {
            // Ignore - might not be available in all contexts
          }
        }
      }
    }
  } catch (e) {
    // Ignore errors in early detection
  }
})();

// Note: cachedRpcHost is declared in middleware.js (loaded before this script)
// We use it from the shared scope

// Inject RPC host into page context for page-script.js
// Uses CSP-safe data attribute instead of inline script
function injectRpcHostToPage() {
  try {
    // Use cachedRpcHost from middleware.js scope - always read current value. Default MUST
    // match the dig-node's actual canonical control port (9778, #132), not the http-standard 80.
    const rpcHost = typeof cachedRpcHost !== 'undefined' ? cachedRpcHost : 'localhost:9778';
    
    // Set data attribute on document element (CSP-safe)
    if (document.documentElement) {
      document.documentElement.setAttribute('data-dig-rpc-host', rpcHost);
    }
    
    // Also try to set window property if possible (may fail due to CSP, but try anyway)
    // Use Object.defineProperty to avoid CSP issues with direct assignment
    try {
      Object.defineProperty(window, '__DIG_RPC_HOST__', {
        value: rpcHost,
        writable: true,
        configurable: true
      });
    } catch (e) {
      // Ignore if we can't set window property (CSP restriction)
    }
    
    // Dispatch event using postMessage (CSP-safe)
    // The page script listens for this event
    window.postMessage({
      type: 'dig-rpc-host-updated',
      rpcHost: rpcHost
    }, '*');
    
    // Also dispatch a custom event if possible (may be blocked by CSP, but try)
    try {
      window.dispatchEvent(new CustomEvent('dig-rpc-host-updated', {
        detail: { rpcHost: rpcHost }
      }));
    } catch (e) {
      // Ignore if custom events are blocked
    }
  } catch (error) {
    // Ignore errors
  }
}

// Listen for messages from background/middleware to update RPC host
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateRpcHost') {
    // Force re-injection with new RPC host
    injectRpcHostToPage();
    return false;
  }
});

// Also inject when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectRpcHostToPage);
} else {
  injectRpcHostToPage();
}

// Listen for storage changes to re-inject RPC host
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes['server.host'] || changes['server.url'] || changes['server.port']) {
      // Wait a bit for middleware.js to update cachedRpcHost, then re-inject
      setTimeout(() => {
        injectRpcHostToPage();
      }, 50);
    }
  }
});

// Convert chia:// URL - ALL chia:// URLs now use RPC via background script
// This function returns a placeholder that will be replaced by proxyResource
// For cases where proxy isn't used, trigger async proxy via background script
function convertDigUrl(url) {
  if (typeof url === 'string' && url.startsWith('chia://')) {
    // Return a placeholder data URL - actual fetching will be done via proxyResource
    // This prevents browser errors while proxy loads content via RPC
    // The proxyResource function will replace this with the actual data URL from RPC
    return `data:application/octet-stream;base64,`; // Empty placeholder
  }
  return url;
}

// Inject loading spinner for chia:// resources
function injectLoadingSpinner(element, digUrl) {
  // Skip if spinner already exists, but still return removal function
  if (element.dataset.digSpinnerInjected) {
    return () => {
      removeLoadingSpinner(element);
    };
  }
  
  // Mark that spinner is injected
  element.dataset.digSpinnerInjected = 'true';
  
  // Create spinner overlay
  const spinnerId = `dig-spinner-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const spinner = document.createElement('div');
  spinner.id = spinnerId;
  spinner.className = 'dig-loading-spinner';
  spinner.setAttribute('data-dig-url', digUrl);
  
  // Inject spinner styles if not already injected
  if (!document.getElementById('dig-spinner-styles')) {
    const style = document.createElement('style');
    style.id = 'dig-spinner-styles';
    style.textContent = `
      .dig-loading-spinner {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(26, 10, 46, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        border-radius: inherit;
      }
      
      .dig-loading-spinner::before {
        content: '';
        width: 40px;
        height: 40px;
        border: 4px solid rgba(157, 78, 221, 0.3);
        border-top-color: #9D4EDD;
        border-radius: 50%;
        animation: dig-spin 1s linear infinite;
      }
      
      @keyframes dig-spin {
        to { transform: rotate(360deg); }
      }
      
      /* Ensure parent element has position for absolute positioning */
      img[data-dig-spinner-injected],
      video[data-dig-spinner-injected],
      audio[data-dig-spinner-injected],
      iframe[data-dig-spinner-injected],
      object[data-dig-spinner-injected],
      embed[data-dig-spinner-injected] {
        position: relative;
      }
      
      /* For inline elements, make them inline-block */
      img[data-dig-spinner-injected] {
        display: inline-block;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  
  // Make element position relative if it's not already
  const computedStyle = window.getComputedStyle(element);
  if (computedStyle.position === 'static') {
    element.style.position = 'relative';
  }
  
  // Append spinner to element
  element.appendChild(spinner);
  
  // Return function to remove spinner
  return () => {
    const spinnerEl = document.getElementById(spinnerId);
    if (spinnerEl) {
      spinnerEl.remove();
    }
    delete element.dataset.digSpinnerInjected;
  };
}

// Remove loading spinner for chia:// resources
function removeLoadingSpinner(element) {
  const spinner = element.querySelector('.dig-loading-spinner');
  if (spinner) {
    spinner.remove();
  }
  delete element.dataset.digSpinnerInjected;
}

// Proxy a resource through the background service worker and set as blob URL
// Now uses middleware system with all fallback strategies
async function proxyResource(element, attribute, digUrl) {
  // Inject spinner before loading
  const removeSpinner = injectLoadingSpinner(element, digUrl);
  
  try {
    // Use the middleware system for comprehensive fallback handling
    await digResourceLoader.loadAndApply(element, attribute, digUrl);
    
    // Remove spinner on success
    removeSpinner();
    
    // Register event handlers for error recovery
    digResourceLoader.registerErrorHandler(element, digUrl);
    digResourceLoader.registerLoadHandler(element, digUrl);
    
    return true;
  } catch (error) {
    // Remove spinner on error
    removeSpinner();
    throw error;
  }
}

// Proxy a stylesheet and inject as <style> tag
async function proxyStylesheet(linkElement, digUrl) {
  try {
    const response = await new Promise((resolve, reject) => {
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
    
    // Fetch the CSS content
    const cssResponse = await fetch(response.data);
    const cssText = await cssResponse.text();
    
    // Create a <style> tag with the CSS
    const styleElement = document.createElement('style');
    styleElement.textContent = cssText;
    styleElement.setAttribute('data-dig-proxied', digUrl);
    
    // Insert after the link element or in head
    if (linkElement.parentNode) {
      linkElement.parentNode.insertBefore(styleElement, linkElement.nextSibling);
      linkElement.remove(); // Remove original link
    } else if (document.head) {
      document.head.appendChild(styleElement);
    }
    
    return true;
  } catch (error) {
    console.warn('DIG Extension: Stylesheet proxy failed for', digUrl, error);
    throw error;
  }
}

// Proxy a script and inject inline
async function proxyScript(scriptElement, digUrl) {
  try {
    const response = await new Promise((resolve, reject) => {
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
    
    // Fetch the JS content
    const jsResponse = await fetch(response.data);
    const jsText = await jsResponse.text();
    
    // Replace script src with inline code
    scriptElement.removeAttribute('src');
    scriptElement.textContent = jsText;
    scriptElement.setAttribute('data-dig-proxied', digUrl);
    
    return true;
  } catch (error) {
    console.warn('DIG Extension: Script proxy failed for', digUrl, error);
    throw error;
  }
}

// Check if extension is enabled (async)
async function isExtensionEnabled() {
  const result = await chrome.storage.local.get(['extensionEnabled']);
  return result.extensionEnabled !== false; // Default to true
}

// Check if extension is enabled (synchronous check with fallback)
let extensionEnabledCache = true; // Default to enabled
function isExtensionEnabledSync() {
  return extensionEnabledCache;
}

// Initialize extension state immediately (synchronous)
// We'll assume enabled by default and update asynchronously
extensionEnabledCache = true; // Default to enabled, will be updated

// Update cache asynchronously
chrome.storage.local.get(['extensionEnabled'], (result) => {
  extensionEnabledCache = result.extensionEnabled !== false; // Default to true
  if (extensionEnabledCache) {
    // Process immediately when we know it's enabled
    processAllElementsImmediately();
  }
});

// Listen for changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.extensionEnabled) {
    extensionEnabledCache = changes.extensionEnabled.newValue !== false;
    if (extensionEnabledCache) {
      processAllElementsImmediately();
    }
  }
});

// Process a single element synchronously (for use in MutationObserver and other callbacks)
// This function is defined outside processAllElementsImmediately so it can be accessed globally
function processElementSync(element) {
    if (!element) return;
    
    // Only process if element has chia:// URLs - skip everything else
    let hasDigUrl = false;
    
    // Handle img src and srcset - proxy via RPC immediately
    if (element.tagName === 'IMG') {
      // Check attribute first (more reliable at document_start)
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        hasDigUrl = true;
        // Inject spinner immediately
        const removeSpinner = injectLoadingSpinner(element, srcAttr);
        // Proxy via RPC - don't set placeholder URL
        proxyResource(element, 'src', srcAttr).then(() => {
          removeSpinner();
        }).catch((error) => {
          console.warn('DIG Extension: Image proxy failed:', error);
          removeSpinner();
          // On error, set placeholder to prevent browser errors
          element.setAttribute('src', convertDigUrl(srcAttr));
        });
      }
      // Also check property as fallback
      if (element.src && typeof element.src === 'string' && element.src.startsWith('chia://')) {
        hasDigUrl = true;
        // Inject spinner immediately
        const removeSpinner = injectLoadingSpinner(element, element.src);
        // Proxy via RPC - don't set placeholder URL
        proxyResource(element, 'src', element.src).then(() => {
          removeSpinner();
        }).catch((error) => {
          console.warn('DIG Extension: Image proxy failed:', error);
          removeSpinner();
          // On error, set placeholder
          element.src = convertDigUrl(element.src);
        });
      }
      // Handle srcset - proxy each chia:// URL via RPC
      const srcsetAttr = element.getAttribute('srcset');
      if (srcsetAttr && srcsetAttr.includes('chia://')) {
        hasDigUrl = true;
        // Parse srcset and proxy each chia:// URL individually
        const srcsetParts = srcsetAttr.split(',');
        const proxiedParts = [];
        const proxyPromises = [];
        
        srcsetParts.forEach((part, index) => {
          const trimmed = part.trim();
          const digMatch = trimmed.match(/^(chia:\/\/[^\s]+)(\s+.+)?$/);
          if (digMatch) {
            const digUrl = digMatch[1];
            const descriptor = digMatch[2] || '';
            // Proxy this URL via RPC
            const proxyPromise = (async () => {
              try {
                const result = await digResourceLoader.loadResource(element, 'srcset', digUrl, 10);
                if (result.strategy === 'proxy' || result.strategy === 'proxy-retry') {
                  // result.data is the proxyResponse: { success: true, data: dataUrl, ... }
                  // So result.data.data is the dataUrl
                  const dataUrl = result.data.data;
                  proxiedParts[index] = dataUrl + descriptor;
                } else {
                  // Fallback to original
                  proxiedParts[index] = trimmed;
                }
              } catch (error) {
                console.warn('DIG Extension: Failed to proxy srcset URL:', digUrl, error);
                // On error, keep original
                proxiedParts[index] = trimmed;
              }
            })();
            proxyPromises.push(proxyPromise);
            // Initially keep original to prevent errors
            proxiedParts[index] = trimmed;
          } else {
            proxiedParts[index] = trimmed;
          }
        });
        
        // Update srcset once all proxies complete
        if (proxyPromises.length > 0) {
          Promise.all(proxyPromises).then(() => {
            element.setAttribute('srcset', proxiedParts.join(', '));
          }).catch((error) => {
            console.error('DIG Extension: Error updating srcset:', error);
          });
        }
      }
      if (element.srcset && element.srcset.includes('chia://')) {
        hasDigUrl = true;
        // Same handling for element.srcset property
        const srcsetParts = element.srcset.split(',');
        const proxiedParts = [];
        const proxyPromises = [];
        
        srcsetParts.forEach((part, index) => {
          const trimmed = part.trim();
          const digMatch = trimmed.match(/^(chia:\/\/[^\s]+)(\s+.+)?$/);
          if (digMatch) {
            const digUrl = digMatch[1];
            const descriptor = digMatch[2] || '';
            const proxyPromise = (async () => {
              try {
                const result = await digResourceLoader.loadResource(element, 'srcset', digUrl, 10);
                if (result.strategy === 'proxy' || result.strategy === 'proxy-retry') {
                  const dataUrl = result.data.data;
                  proxiedParts[index] = dataUrl + descriptor;
                } else {
                  proxiedParts[index] = trimmed;
                }
              } catch (error) {
                console.warn('DIG Extension: Failed to proxy srcset URL:', digUrl, error);
                proxiedParts[index] = trimmed;
              }
            })();
            proxyPromises.push(proxyPromise);
            proxiedParts[index] = trimmed;
          } else {
            proxiedParts[index] = trimmed;
          }
        });
        
        if (proxyPromises.length > 0) {
          Promise.all(proxyPromises).then(() => {
            element.srcset = proxiedParts.join(', ');
          }).catch((error) => {
            console.error('DIG Extension: Error updating srcset:', error);
          });
        }
      }
    }
    
    // Handle picture source elements - proxy src with middleware, convert srcset
    if (element.tagName === 'SOURCE') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        hasDigUrl = true;
        digResourceLoader.loadAndApply(element, 'src', srcAttr, 5).catch(() => {});
        digResourceLoader.registerErrorHandler(element, srcAttr);
        digResourceLoader.registerLoadHandler(element, srcAttr);
      }
      if (element.src && element.src.startsWith('chia://')) {
        hasDigUrl = true;
        digResourceLoader.loadAndApply(element, 'src', element.src, 5).catch(() => {});
        digResourceLoader.registerErrorHandler(element, element.src);
        digResourceLoader.registerLoadHandler(element, element.src);
      }
      // srcset - proxy each chia:// URL via RPC
      if (element.srcset && element.srcset.includes('chia://')) {
        const srcsetParts = element.srcset.split(',');
        const proxiedParts = [];
        const proxyPromises = [];
        
        srcsetParts.forEach((part, index) => {
          const trimmed = part.trim();
          const digMatch = trimmed.match(/^(chia:\/\/[^\s]+)(\s+.+)?$/);
          if (digMatch) {
            const digUrl = digMatch[1];
            const descriptor = digMatch[2] || '';
            const proxyPromise = (async () => {
              try {
                const result = await digResourceLoader.loadResource(element, 'srcset', digUrl, 10);
                if (result.strategy === 'proxy' || result.strategy === 'proxy-retry') {
                  // result.data.data is the data URL from RPC
                  proxiedParts[index] = result.data.data + descriptor;
                } else {
                  proxiedParts[index] = trimmed;
                }
              } catch (error) {
                proxiedParts[index] = trimmed;
              }
            })();
            proxyPromises.push(proxyPromise);
            proxiedParts[index] = trimmed;
          } else {
            proxiedParts[index] = trimmed;
          }
        });
        
        if (proxyPromises.length > 0) {
          Promise.all(proxyPromises).then(() => {
            element.srcset = proxiedParts.join(', ');
          });
        }
      }
    }
    
    // Handle script src - proxy through background worker with middleware
    if (element.tagName === 'SCRIPT') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        hasDigUrl = true;
        // For scripts, use special handling - inject inline if proxy succeeds
        (async () => {
          try {
            const result = await digResourceLoader.loadResource(element, 'src', srcAttr, 10);
            if (result.strategy === 'proxy' || result.strategy === 'proxy-retry') {
              // Inject script inline
              const jsResponse = await fetch(result.data.data);
              const jsText = await jsResponse.text();
              element.removeAttribute('src');
              element.textContent = jsText;
              element.setAttribute('data-dig-proxied', srcAttr);
            } else if (result.strategy === 'redirect') {
              // Use converted URL
              element.setAttribute('src', result.data);
            }
          } catch (error) {
            // Fallback handled by middleware
            const convertedUrl = convertDigUrl(srcAttr);
            element.setAttribute('src', convertedUrl);
          }
        })();
        digResourceLoader.registerErrorHandler(element, srcAttr);
      } else if (element.src && element.src.startsWith('chia://')) {
        hasDigUrl = true;
        (async () => {
          try {
            const result = await digResourceLoader.loadResource(element, 'src', element.src, 10);
            if (result.strategy === 'proxy' || result.strategy === 'proxy-retry') {
              const jsResponse = await fetch(result.data.data);
              const jsText = await jsResponse.text();
              element.removeAttribute('src');
              element.textContent = jsText;
              element.setAttribute('data-dig-proxied', element.src);
            } else if (result.strategy === 'redirect') {
              element.src = result.data;
            }
          } catch (error) {
            element.src = convertDigUrl(element.src);
          }
        })();
        digResourceLoader.registerErrorHandler(element, element.src);
      }
    }
    
    // Handle link (stylesheet, icon, etc.) - proxy all link types
    if (element.tagName === 'LINK') {
      const hrefAttr = element.getAttribute('href');
      if (hrefAttr && hrefAttr.startsWith('chia://')) {
        hasDigUrl = true;
        const rel = element.getAttribute('rel');
        // Proxy stylesheets via inline injection, other link types via blob URL
        if (rel === 'stylesheet' || rel === 'style') {
          proxyStylesheet(element, hrefAttr).catch(() => {
            // Fallback to URL conversion
            element.setAttribute('href', convertDigUrl(hrefAttr));
          });
        } else {
          // For other link types (icons, etc.), proxy as resource
          proxyResource(element, 'href', hrefAttr).catch(() => {
            element.setAttribute('href', convertDigUrl(hrefAttr));
          });
        }
      } else if (element.href && element.href.startsWith('chia://')) {
        hasDigUrl = true;
        const rel = element.getAttribute('rel');
        if (rel === 'stylesheet' || rel === 'style') {
          proxyStylesheet(element, element.href).catch(() => {
            element.href = convertDigUrl(element.href);
          });
        } else {
          proxyResource(element, 'href', element.href).catch(() => {
            element.href = convertDigUrl(element.href);
          });
        }
      }
    }
    
    // Handle video/audio sources - proxy via RPC immediately
    if (element.tagName === 'VIDEO' || element.tagName === 'AUDIO') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        hasDigUrl = true;
        // Inject spinner immediately
        const removeSpinner = injectLoadingSpinner(element, srcAttr);
        // Proxy via RPC - don't set placeholder URL
        proxyResource(element, 'src', srcAttr).then(() => {
          removeSpinner();
        }).catch((error) => {
          console.warn('DIG Extension: Video/audio proxy failed:', error);
          removeSpinner();
          // On error, try to set a placeholder to prevent browser errors
          element.setAttribute('src', convertDigUrl(srcAttr));
        });
      }
      if (element.src && typeof element.src === 'string' && element.src.startsWith('chia://')) {
        hasDigUrl = true;
        // Inject spinner immediately
        const removeSpinner = injectLoadingSpinner(element, element.src);
        // Proxy via RPC - don't set placeholder URL
        proxyResource(element, 'src', element.src).then(() => {
          removeSpinner();
        }).catch((error) => {
          console.warn('DIG Extension: Video/audio proxy failed:', error);
          removeSpinner();
          // On error, try to set a placeholder
          element.src = convertDigUrl(element.src);
        });
      }
    }
    
    // Handle iframe src - proxy through background worker
    if (element.tagName === 'IFRAME') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        hasDigUrl = true;
        // For iframes, we need to convert to localhost since blob URLs won't work for iframes
        // But try to proxy first to see if we can get the content
        // Actually, iframes need full page navigation, so convert is the only option
        element.setAttribute('src', convertDigUrl(srcAttr));
      }
      if (element.src && element.src.startsWith('chia://')) {
        hasDigUrl = true;
        element.src = convertDigUrl(element.src);
      }
    }
    
    // Handle object/embed - proxy through background worker
    if (element.tagName === 'OBJECT' || element.tagName === 'EMBED') {
      const dataAttr = element.getAttribute('data');
      if (dataAttr && dataAttr.startsWith('chia://')) {
        hasDigUrl = true;
        proxyResource(element, 'data', dataAttr).catch(() => {
          element.setAttribute('data', convertDigUrl(dataAttr));
        });
      }
      if (element.data && element.data.startsWith('chia://')) {
        hasDigUrl = true;
        proxyResource(element, 'data', element.data).catch(() => {
          element.data = convertDigUrl(element.data);
        });
      }
    }
    
    // Handle SVG elements - <use>, <image>, gradients, patterns
    if (element.tagName === 'USE' || element.tagName === 'use') {
      const hrefAttr = element.getAttribute('href') || element.getAttribute('xlink:href');
      if (hrefAttr && hrefAttr.startsWith('chia://')) {
        hasDigUrl = true;
        element.setAttribute('href', convertDigUrl(hrefAttr));
        if (element.hasAttribute('xlink:href')) {
          element.setAttribute('xlink:href', convertDigUrl(hrefAttr));
        }
      }
    }
    if (element.tagName === 'IMAGE' || element.tagName === 'image') {
      const hrefAttr = element.getAttribute('href') || element.getAttribute('xlink:href');
      if (hrefAttr && hrefAttr.startsWith('chia://')) {
        hasDigUrl = true;
        element.setAttribute('href', convertDigUrl(hrefAttr));
        if (element.hasAttribute('xlink:href')) {
          element.setAttribute('xlink:href', convertDigUrl(hrefAttr));
        }
      }
    }
    // SVG gradients and patterns with chia:// URLs in href/xlink:href
    if (element.tagName === 'LINEARGRADIENT' || element.tagName === 'RADIALGRADIENT' || 
        element.tagName === 'PATTERN' || element.tagName === 'linearGradient' || 
        element.tagName === 'radialGradient' || element.tagName === 'pattern') {
      const hrefAttr = element.getAttribute('href') || element.getAttribute('xlink:href');
      if (hrefAttr && hrefAttr.startsWith('chia://')) {
        hasDigUrl = true;
        element.setAttribute('href', convertDigUrl(hrefAttr));
        if (element.hasAttribute('xlink:href')) {
          element.setAttribute('xlink:href', convertDigUrl(hrefAttr));
        }
      }
    }
    
    // Handle form elements with action/formaction
    if (element.tagName === 'FORM') {
      const actionAttr = element.getAttribute('action');
      if (actionAttr && actionAttr.startsWith('chia://')) {
        hasDigUrl = true;
        element.setAttribute('action', convertDigUrl(actionAttr));
      }
    }
    if (element.tagName === 'INPUT' || element.tagName === 'BUTTON') {
      const formactionAttr = element.getAttribute('formaction');
      if (formactionAttr && formactionAttr.startsWith('chia://')) {
        hasDigUrl = true;
        element.setAttribute('formaction', convertDigUrl(formactionAttr));
      }
    }
    
    // Handle link tags with resource hints (preconnect, prefetch, preload, dns-prefetch)
    if (element.tagName === 'LINK') {
      const rel = element.getAttribute('rel');
      const hrefAttr = element.getAttribute('href');
      if (hrefAttr && hrefAttr.startsWith('chia://')) {
        hasDigUrl = true;
        if (rel === 'stylesheet' || rel === 'style') {
          proxyStylesheet(element, hrefAttr).catch(() => {
            element.setAttribute('href', convertDigUrl(hrefAttr));
          });
        } else if (rel === 'icon' || rel === 'shortcut icon' || rel === 'apple-touch-icon') {
          // Favicon - convert URL
          element.setAttribute('href', convertDigUrl(hrefAttr));
        } else if (rel === 'manifest') {
          // Web app manifest - convert URL
          element.setAttribute('href', convertDigUrl(hrefAttr));
        } else if (rel === 'preconnect' || rel === 'prefetch' || rel === 'preload' || rel === 'dns-prefetch') {
          // Resource hints - convert URL
          element.setAttribute('href', convertDigUrl(hrefAttr));
        } else {
          // Other link types - proxy as resource
          proxyResource(element, 'href', hrefAttr).catch(() => {
            element.setAttribute('href', convertDigUrl(hrefAttr));
          });
        }
      }
    }
    
    // Handle meta tags with chia:// URLs (og:image, twitter:image, etc.)
    if (element.tagName === 'META') {
      const property = element.getAttribute('property') || element.getAttribute('name');
      const content = element.getAttribute('content');
      if (content && content.startsWith('chia://') && 
          (property === 'og:image' || property === 'og:image:url' || 
           property === 'twitter:image' || property === 'twitter:image:src' ||
           property === 'image' || property === 'thumbnail')) {
        hasDigUrl = true;
        element.setAttribute('content', convertDigUrl(content));
      }
    }
    
    // Handle HTML5 data attributes that might contain chia:// URLs
    // Check all data-* attributes
    if (element.hasAttributes && element.hasAttributes()) {
      Array.from(element.attributes).forEach(attr => {
        if (attr.name.startsWith('data-') && attr.value && attr.value.startsWith('chia://')) {
          hasDigUrl = true;
          element.setAttribute(attr.name, convertDigUrl(attr.value));
        }
      });
    }
    
    // Handle custom elements and web components
    // Check if element is a custom element with chia:// URLs in attributes
    if (element.localName && element.localName.includes('-')) {
      // This is likely a custom element (web component)
      // Process all its attributes for chia:// URLs
      Array.from(element.attributes || []).forEach(attr => {
        if (attr.value && attr.value.startsWith('chia://')) {
          hasDigUrl = true;
          element.setAttribute(attr.name, convertDigUrl(attr.value));
        }
      });
    }
    
    // Handle Shadow DOM - process shadow root if it exists
    if (element.shadowRoot) {
      // Process elements inside shadow DOM
      const shadowElements = element.shadowRoot.querySelectorAll('*');
      shadowElements.forEach(shadowEl => {
        // Recursively process shadow DOM elements
        if (typeof processElementSync !== 'undefined') {
          processElementSync(shadowEl);
        }
      });
    }
    
    // Handle inline styles with chia:// URLs
    if (element.hasAttribute && element.hasAttribute('style')) {
      const styleText = element.getAttribute('style');
      if (styleText && styleText.includes('chia://')) {
        const newStyle = styleText.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (match, url) => {
          return `url(${convertDigUrl(url)})`;
        });
        if (newStyle !== styleText) {
          element.setAttribute('style', newStyle);
        }
      }
    }
    
    // Handle style tags - process @import, @font-face, url(), and CSS custom properties
    if (element.tagName === 'STYLE' && element.textContent) {
      let newContent = element.textContent;
      
      // Convert @import statements with chia:// URLs
      // Matches: @import url('chia://...'); or @import 'chia://...';
      newContent = newContent.replace(/@import\s+(?:url\()?['"]?(chia:\/\/[^'")]+)['"]?\)?;?/gi, (match, url) => {
        const convertedUrl = convertDigUrl(url);
        // Preserve the format (url() or plain string)
        if (match.includes('url(')) {
          return match.replace(url, convertedUrl);
        } else {
          return `@import url('${convertedUrl}');`;
        }
      });
      
      // Convert @font-face src with chia:// URLs
      // Matches: @font-face { src: url('chia://...'); } or src: url('chia://...') format('woff2');
      newContent = newContent.replace(/@font-face\s*\{[^}]*src\s*:\s*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
        return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
          return `url('${convertDigUrl(url)}')`;
        });
      });
      
      // Convert url() functions with chia:// URLs - preserve quote style
      newContent = newContent.replace(/url\((['"]?)(chia:\/\/[^'")]+)\1\)/gi, (match, quote, url) => {
        const convertedUrl = convertDigUrl(url);
        // Use single quotes for consistency
        return `url('${convertedUrl}')`;
      });
      
      // Convert @keyframes with chia:// URLs
      newContent = newContent.replace(/@keyframes\s+\w+\s*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
        return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
          return `url('${convertDigUrl(url)}')`;
        });
      });
      
      // Convert @property with chia:// URLs
      newContent = newContent.replace(/@property\s+[^\{]+\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
        return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
          return `url('${convertDigUrl(url)}')`;
        });
      });
      
      // Convert @layer with chia:// URLs
      newContent = newContent.replace(/@layer[^\{]*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
        return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
          return `url('${convertDigUrl(url)}')`;
        });
      });
      
      // Convert @container with chia:// URLs
      newContent = newContent.replace(/@container[^\{]*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
        return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
          return `url('${convertDigUrl(url)}')`;
        });
      });
      
      // Convert @scope with chia:// URLs
      newContent = newContent.replace(/@scope[^\{]*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
        return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
          return `url('${convertDigUrl(url)}')`;
        });
      });
      
      // Convert @font-palette-values with chia:// URLs
      newContent = newContent.replace(/@font-palette-values[^\{]*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
        return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
          return `url('${convertDigUrl(url)}')`;
        });
      });
      
      // Convert CSS custom properties (CSS variables) with chia:// URLs
      // Matches: --variable: url('chia://...');
      newContent = newContent.replace(/(--[^:]+):\s*url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (match, prop, url) => {
        return `${prop}: url('${convertDigUrl(url)}')`;
      });
      
      if (newContent !== element.textContent) {
        element.textContent = newContent;
      }
    }
}

// Process all elements immediately (synchronous, no async checks)
// Only processes elements with chia:// URLs - non-blocking
function processAllElementsImmediately() {
  // Process all elements in the document - but only those with chia:// URLs
  // Use a more targeted approach to avoid processing everything
  if (document.documentElement) {
    // First, try to find elements with chia:// in attributes
    const selectors = [
      'img[src^="chia://"]',
      'script[src^="chia://"]',
      'link[href^="chia://"]',
      'source[src^="chia://"]',
      'source[srcset*="chia://"]',
      'video[src^="chia://"]',
      'audio[src^="chia://"]',
      'iframe[src^="chia://"]',
      'object[data^="chia://"]',
      'embed[data^="chia://"]',
      '[style*="chia://"]',
      'style'
    ];
    
    // Process elements matching selectors
    selectors.forEach(selector => {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(processElementSync);
      } catch (e) {
        // Ignore invalid selectors
      }
    });
    
    // Also process style tags for chia:// in content - handle @import, @font-face, url(), and CSS variables
    const styleTags = document.querySelectorAll('style');
    styleTags.forEach(style => {
      if (style.textContent && style.textContent.includes('chia://')) {
        let newContent = style.textContent;
        
        // Convert @import statements with chia:// URLs
        newContent = newContent.replace(/@import\s+(?:url\()?['"]?(chia:\/\/[^'")]+)['"]?\)?;?/gi, (match, url) => {
          const convertedUrl = convertDigUrl(url);
          if (match.includes('url(')) {
            return match.replace(url, convertedUrl);
          } else {
            return `@import url('${convertedUrl}');`;
          }
        });
        
        // Convert @font-face src with chia:// URLs
        newContent = newContent.replace(/@font-face\s*\{[^}]*src\s*:\s*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
          return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
            return `url('${convertDigUrl(url)}')`;
          });
        });
        
        // Convert url() functions with chia:// URLs - preserve quote style
        newContent = newContent.replace(/url\((['"]?)(chia:\/\/[^'")]+)\1\)/gi, (match, quote, url) => {
          const convertedUrl = convertDigUrl(url);
          // Use single quotes for consistency
          return `url('${convertedUrl}')`;
        });
        
        // Convert @keyframes with chia:// URLs
        newContent = newContent.replace(/@keyframes\s+\w+\s*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
          return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
            return `url('${convertDigUrl(url)}')`;
          });
        });
        
        // Convert @property with chia:// URLs
        newContent = newContent.replace(/@property\s+[^\{]+\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
          return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
            return `url('${convertDigUrl(url)}')`;
          });
        });
        
        // Convert @layer with chia:// URLs
        newContent = newContent.replace(/@layer[^\{]*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
          return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
            return `url('${convertDigUrl(url)}')`;
          });
        });
        
        // Convert @container with chia:// URLs
        newContent = newContent.replace(/@container[^\{]*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
          return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
            return `url('${convertDigUrl(url)}')`;
          });
        });
        
        // Convert @scope with chia:// URLs
        newContent = newContent.replace(/@scope[^\{]*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
          return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
            return `url('${convertDigUrl(url)}')`;
          });
        });
        
        // Convert @font-palette-values with chia:// URLs
        newContent = newContent.replace(/@font-palette-values[^\{]*\{[^}]*url\(['"]?(chia:\/\/[^'")]+)['"]?\)[^}]*\}/gi, (match) => {
          return match.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (urlMatch, url) => {
            return `url('${convertDigUrl(url)}')`;
          });
        });
        
        // Convert CSS custom properties (CSS variables) with chia:// URLs
        newContent = newContent.replace(/(--[^:]+):\s*url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (match, prop, url) => {
          return `${prop}: url('${convertDigUrl(url)}')`;
        });
        
        if (newContent !== style.textContent) {
          style.textContent = newContent;
        }
      }
    });
  }
}

// Intercept and convert chia:// URLs in the DOM
function interceptDigUrls() {
  // Process immediately - don't wait for async checks
  processAllElementsImmediately();
  
  // Cache enabled state for performance
  let extensionEnabled = true; // Default to enabled
  
  // Update enabled state asynchronously
  chrome.storage.local.get(['extensionEnabled'], (result) => {
    extensionEnabled = result.extensionEnabled !== false;
    if (extensionEnabled) {
      processAllElementsImmediately();
    }
  });
  
  // Listen for state changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.extensionEnabled) {
      extensionEnabled = changes.extensionEnabled.newValue !== false;
      if (extensionEnabled) {
        processAllElementsImmediately();
      }
    }
  });
  
  // Function to process a single element
  function processElement(element) {
    if (!element || !extensionEnabled) return;
    
    // Handle img src and srcset - proxy images to avoid network errors
    if (element.tagName === 'IMG') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        // Proxy the image through background worker
        proxyResource(element, 'src', srcAttr).catch(() => {
          element.setAttribute('src', convertDigUrl(srcAttr));
        });
      }
      if (element.src && element.src.startsWith('chia://')) {
        proxyResource(element, 'src', element.src).catch(() => {
          element.src = convertDigUrl(element.src);
        });
      }
      const srcsetAttr = element.getAttribute('srcset');
      if (srcsetAttr && srcsetAttr.includes('chia://')) {
        element.setAttribute('srcset', srcsetAttr.replace(/chia:\/\/[^\s,]+/g, (match) => convertDigUrl(match)));
      }
      if (element.srcset && element.srcset.includes('chia://')) {
        element.srcset = element.srcset.replace(/chia:\/\/[^\s,]+/g, (match) => convertDigUrl(match));
      }
    }
    
    // Handle picture source elements - proxy src, convert srcset
    if (element.tagName === 'SOURCE') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        proxyResource(element, 'src', srcAttr).catch(() => {
          element.setAttribute('src', convertDigUrl(srcAttr));
        });
      }
      if (element.src && element.src.startsWith('chia://')) {
        proxyResource(element, 'src', element.src).catch(() => {
          element.src = convertDigUrl(element.src);
        });
      }
      // srcset - convert since we can't easily proxy multiple URLs
      const srcsetAttr = element.getAttribute('srcset');
      if (srcsetAttr && srcsetAttr.includes('chia://')) {
        element.setAttribute('srcset', srcsetAttr.replace(/chia:\/\/[^\s,]+/g, (match) => convertDigUrl(match)));
      }
      if (element.srcset && element.srcset.includes('chia://')) {
        element.srcset = element.srcset.replace(/chia:\/\/[^\s,]+/g, (match) => convertDigUrl(match));
      }
    }
    
    // Handle script src - proxy through background worker
    if (element.tagName === 'SCRIPT') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        proxyScript(element, srcAttr).catch(() => {
          element.setAttribute('src', convertDigUrl(srcAttr));
        });
      }
      if (element.src && element.src.startsWith('chia://')) {
        proxyScript(element, element.src).catch(() => {
          element.src = convertDigUrl(element.src);
        });
      }
    }
    
    // Handle link (stylesheet, icon, etc.) - proxy all link types
    if (element.tagName === 'LINK') {
      const hrefAttr = element.getAttribute('href');
      if (hrefAttr && hrefAttr.startsWith('chia://')) {
        const rel = element.getAttribute('rel');
        if (rel === 'stylesheet' || rel === 'style') {
          proxyStylesheet(element, hrefAttr).catch(() => {
            element.setAttribute('href', convertDigUrl(hrefAttr));
          });
        } else {
          proxyResource(element, 'href', hrefAttr).catch(() => {
            element.setAttribute('href', convertDigUrl(hrefAttr));
          });
        }
      }
      if (element.href && element.href.startsWith('chia://')) {
        const rel = element.getAttribute('rel');
        if (rel === 'stylesheet' || rel === 'style') {
          proxyStylesheet(element, element.href).catch(() => {
            element.href = convertDigUrl(element.href);
          });
        } else {
          proxyResource(element, 'href', element.href).catch(() => {
            element.href = convertDigUrl(element.href);
          });
        }
      }
    }
    
    // Handle video/audio sources - proxy through background worker
    if (element.tagName === 'VIDEO' || element.tagName === 'AUDIO') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        proxyResource(element, 'src', srcAttr).catch(() => {
          element.setAttribute('src', convertDigUrl(srcAttr));
        });
      }
      if (element.src && element.src.startsWith('chia://')) {
        proxyResource(element, 'src', element.src).catch(() => {
          element.src = convertDigUrl(element.src);
        });
      }
    }
    
    // Handle iframe src - convert (iframes need full page navigation, can't use blob URLs)
    if (element.tagName === 'IFRAME') {
      const srcAttr = element.getAttribute('src');
      if (srcAttr && srcAttr.startsWith('chia://')) {
        // Iframes need full page navigation, so convert is the only option
        element.setAttribute('src', convertDigUrl(srcAttr));
      }
      if (element.src && element.src.startsWith('chia://')) {
        element.src = convertDigUrl(element.src);
      }
    }
    
    // Handle object/embed - proxy through background worker
    if (element.tagName === 'OBJECT' || element.tagName === 'EMBED') {
      const dataAttr = element.getAttribute('data');
      if (dataAttr && dataAttr.startsWith('chia://')) {
        proxyResource(element, 'data', dataAttr).catch(() => {
          element.setAttribute('data', convertDigUrl(dataAttr));
        });
      }
      if (element.data && element.data.startsWith('chia://')) {
        proxyResource(element, 'data', element.data).catch(() => {
          element.data = convertDigUrl(element.data);
        });
      }
    }
    
    // Handle style tags and inline styles with chia:// URLs
    if (element.tagName === 'STYLE' && element.textContent) {
      let newContent = element.textContent;
      
      // Convert @import statements with chia:// URLs
      newContent = newContent.replace(/@import\s+(?:url\()?['"]?(chia:\/\/[^'")]+)['"]?\)?;?/gi, (match, url) => {
        const convertedUrl = convertDigUrl(url);
        if (match.includes('url(')) {
          return match.replace(url, convertedUrl);
        } else {
          return `@import url('${convertedUrl}');`;
        }
      });
      
      // Convert url() functions with chia:// URLs - preserve quote style
      newContent = newContent.replace(/url\((['"]?)(chia:\/\/[^'")]+)\1\)/gi, (match, quote, url) => {
        const convertedUrl = convertDigUrl(url);
        // Use single quotes for consistency
        return `url('${convertedUrl}')`;
      });
      
      if (newContent !== element.textContent) {
        element.textContent = newContent;
      }
    }
    
    if (element.hasAttribute && element.hasAttribute('style') && element.style) {
      const styleText = element.getAttribute('style');
      if (styleText && styleText.includes('chia://')) {
        const newStyle = styleText.replace(/url\(['"]?(chia:\/\/[^'")]+)['"]?\)/gi, (match, url) => {
          return `url(${convertDigUrl(url)})`;
        });
        element.setAttribute('style', newStyle);
      }
    }
  }
  
  // Process all existing elements
  function processAllElements() {
    if (!extensionEnabled) return;
    processAllElementsImmediately();
  }
  
  // Process immediately - don't wait for DOMContentLoaded
  // This is critical - we need to process before browser loads resources
  if (document.documentElement) {
    processAllElementsImmediately();
  }
  
  // Process once more when DOM is ready, then stop
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (extensionEnabled && !initialProcessingComplete) {
        processAllElementsImmediately();
        initialProcessingComplete = true;
      }
    }, { once: true });
  } else {
    if (extensionEnabled && !initialProcessingComplete) {
      processAllElementsImmediately();
      initialProcessingComplete = true;
    }
  }
  
  // No MutationObserver - we only process once during initial load
  // AJAX/fetch/XHR interceptors handle dynamic requests
}

// Intercept fetch API
function interceptFetch() {
  // Cache enabled state
  let extensionEnabled = false;
  
  async function updateEnabledState() {
    extensionEnabled = await isExtensionEnabled();
  }
  
  updateEnabledState();
  
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.extensionEnabled) {
      extensionEnabled = changes.extensionEnabled.newValue;
    }
  });
  
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    if (extensionEnabled) {
      let url = args[0];
      let isDigUrl = false;
      
      if (typeof url === 'string' && url.startsWith('chia://')) {
        isDigUrl = true;
      } else if (url instanceof Request && url.url.startsWith('chia://')) {
        isDigUrl = true;
        url = url.url;
      }
      
      if (isDigUrl) {
        // Try to proxy through background service worker first
        try {
          const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { action: 'proxyRequest', url: url },
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
                  // Convert data URL to blob and create Response
                  fetch(proxyResponse.data)
                    .then(r => r.blob())
                    .then(blob => {
                      resolve(new Response(blob, {
                        status: 200,
                        statusText: 'OK',
                        headers: {
                          'Content-Type': proxyResponse.contentType
                        }
                      }));
                    })
                    .catch(reject);
                } else {
                  reject(new Error('Unknown proxy response'));
                }
              }
            );
          });
          return response;
        } catch (error) {
          console.warn('DIG Extension: Proxy failed, falling back to redirect:', error);
          // Fallback to URL conversion
          if (typeof args[0] === 'string') {
            args[0] = convertDigUrl(args[0]);
          } else if (args[0] instanceof Request) {
            const newUrl = convertDigUrl(args[0].url);
            args[0] = new Request(newUrl, args[0]);
          }
        }
      }
    }
    return originalFetch.apply(this, args);
  };
}

// Intercept XMLHttpRequest
function interceptXHR() {
  // Store enabled state (will be updated when extension state changes)
  let extensionEnabled = false;
  
  // Update enabled state
  async function updateEnabledState() {
    extensionEnabled = await isExtensionEnabled();
  }
  
  // Initial state check
  updateEnabledState();
  
  // Listen for state changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.extensionEnabled) {
      extensionEnabled = changes.extensionEnabled.newValue;
    }
  });
  
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    // Store the original URL and method if it's a chia:// URL
    if (extensionEnabled && typeof url === 'string' && url.startsWith('chia://')) {
      this._digUrl = url;
      this._digMethod = method;
      this._digRest = rest;
      // Store the original URL for now, we'll proxy in send()
      return originalOpen.call(this, method, url, ...rest);
    } else {
      this._digUrl = null;
    }
    return originalOpen.call(this, method, url, ...rest);
  };
  
  XMLHttpRequest.prototype.send = function(...args) {
    // If this is a chia:// request, proxy it through background worker
    if (extensionEnabled && this._digUrl) {
      const digUrl = this._digUrl;
      const method = this._digMethod || 'GET';
      this._digUrl = null; // Clear it
      
      // Proxy the request
      chrome.runtime.sendMessage(
        { action: 'proxyRequest', url: digUrl },
        (proxyResponse) => {
          if (chrome.runtime.lastError) {
            console.warn('DIG Extension: XHR proxy failed:', chrome.runtime.lastError.message);
            // Fallback to URL conversion
            const localhostUrl = convertDigUrl(digUrl);
            // Re-open with localhost URL
            originalOpen.call(this, method, localhostUrl, ...(this._digRest || []));
            originalSend.apply(this, args);
            return;
          }
          
          if (proxyResponse.error) {
            console.warn('DIG Extension: XHR proxy error:', proxyResponse.error);
            // Fallback to URL conversion
            const localhostUrl = convertDigUrl(digUrl);
            originalOpen.call(this, method, localhostUrl, ...(this._digRest || []));
            originalSend.apply(this, args);
            return;
          }
          
          if (proxyResponse.success) {
            // Convert data URL to blob/text and set response
            fetch(proxyResponse.data)
              .then(r => {
                // Determine response type based on content type
                const contentType = proxyResponse.contentType || '';
                if (contentType.includes('application/json') || contentType.includes('text/')) {
                  return r.text();
                } else {
                  return r.blob();
                }
              })
              .then(responseData => {
                // Set response properties
                Object.defineProperty(this, 'status', { value: 200, writable: false, configurable: true });
                Object.defineProperty(this, 'statusText', { value: 'OK', writable: false, configurable: true });
                Object.defineProperty(this, 'readyState', { value: 4, writable: false, configurable: true });
                
                if (typeof responseData === 'string') {
                  Object.defineProperty(this, 'responseText', { value: responseData, writable: false, configurable: true });
                  Object.defineProperty(this, 'response', { value: responseData, writable: false, configurable: true });
                  Object.defineProperty(this, 'responseType', { value: 'text', writable: false, configurable: true });
                } else {
                  Object.defineProperty(this, 'response', { value: responseData, writable: false, configurable: true });
                  Object.defineProperty(this, 'responseText', { value: '', writable: false, configurable: true });
                  Object.defineProperty(this, 'responseType', { value: 'blob', writable: false, configurable: true });
                }
                
                // Trigger events in order
                if (this.readyState === 4) {
                  if (this.onreadystatechange) {
                    this.onreadystatechange(new Event('readystatechange'));
                  }
                  this.dispatchEvent(new Event('readystatechange'));
                  
                  if (this.onload) {
                    this.onload(new Event('load'));
                  }
                  this.dispatchEvent(new Event('load'));
                  
                  if (this.onloadend) {
                    this.onloadend(new Event('loadend'));
                  }
                  this.dispatchEvent(new Event('loadend'));
                }
                
                reportSuccess(digUrl, 'xhr-proxy');
              })
              .catch(error => {
                console.warn('DIG Extension: XHR proxy response processing failed:', error);
                reportError(digUrl, error, 'xhr-proxy');
                // Fallback to URL conversion
                const localhostUrl = convertDigUrl(digUrl);
                originalOpen.call(this, method, localhostUrl, ...(this._digRest || []));
                originalSend.apply(this, args);
              });
            return; // Don't call original send
          } else {
            // Fallback to URL conversion
            const localhostUrl = convertDigUrl(digUrl);
            originalOpen.call(this, method, localhostUrl, ...(this._digRest || []));
            originalSend.apply(this, args);
          }
        }
      );
      return; // Don't call original send yet
    }
    
    // For non-chia:// URLs, call original send
    return originalSend.apply(this, args);
  };
}

// Intercept link clicks (for navigation)
function interceptLinkClicks() {
  // Cache enabled state
  let extensionEnabled = false;
  
  async function updateEnabledState() {
    extensionEnabled = await isExtensionEnabled();
  }
  
  updateEnabledState();
  
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.extensionEnabled) {
      extensionEnabled = changes.extensionEnabled.newValue;
    }
  });
  
  document.addEventListener('click', (e) => {
    // Only intercept chia:// links
    if (!extensionEnabled) return;
    
    let target = e.target;
    
    // Find the link element
    while (target && target.tagName !== 'A' && target !== document.body) {
      target = target.parentElement;
    }
    
    if (target && target.tagName === 'A' && target.href && target.href.startsWith('chia://')) {
      e.preventDefault();
      e.stopPropagation();
      
      const localhostUrl = convertDigUrl(target.href);
      window.location.href = localhostUrl;
      return false;
    }
  }, true);
  
  // Intercept programmatic navigation via window.location.href (fallback)
  // The page script should handle this, but we add it here as a backup
  // Also listen for navigation requests from page script
  window.addEventListener('message', (event) => {
    // Only accept messages from same origin
    if (event.origin !== window.location.origin) return;
    
    if (event.data && event.data.type === 'dig-navigate' && event.data.url) {
      const digUrl = event.data.url;
      if (digUrl.startsWith('chia://')) {
        const localhostUrl = convertDigUrl(digUrl);
        // Use background script's chrome.tabs.update for most reliable navigation
        chrome.runtime.sendMessage({
          action: 'navigate',
          url: localhostUrl
        }, (response) => {
          // If background script navigation fails, fallback to local navigation
          if (chrome.runtime.lastError || !response || !response.success) {
            window.location.replace(localhostUrl);
          }
        });
      }
    }
  });
  
  // Try to intercept location in content script as well (fallback)
  try {
    const originalLocation = window.location;
    const locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    
    if (locationDescriptor && locationDescriptor.configurable) {
      let locationValue = originalLocation;
      
      Object.defineProperty(window, 'location', {
        get: function() {
          return locationValue;
        },
        set: function(value) {
          if (extensionEnabled && typeof value === 'string' && value.startsWith('chia://')) {
            const localhostUrl = convertDigUrl(value);
            // Use replace() to avoid recursion
            window.location.replace(localhostUrl);
          } else {
            locationValue.href = value;
          }
        },
        configurable: true
      });
    }
  } catch (e) {
    // If we can't override location in content script, the page script should handle it
    // This is expected - location interception works better in page script context
  }
}

// Inject page script to intercept at page level
function injectPageScript() {
  try {
    // Inject script from file (CSP-safe)
    // Use a script element with src attribute, not inline code
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-script.js');
    script.onload = function() {
      // Remove after loading to keep DOM clean
      try {
        this.remove();
      } catch (e) {
        // Ignore removal errors
      }
    };
    script.onerror = function() {
      // If script fails to load, log but don't break
      console.warn('DIG Extension: Failed to load page script');
    };
    
    // Inject as early as possible
    if (document.head) {
      document.head.appendChild(script);
    } else if (document.documentElement) {
      document.documentElement.appendChild(script);
    } else {
      // Fallback: wait for document to be ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          (document.head || document.documentElement).appendChild(script);
        }, { once: true });
      }
    }
  } catch (error) {
    console.warn('DIG Extension: Error injecting page script', error);
  }
}

// Inject the CHIP-0002 `window.chia` provider (dig-provider.js) into the page's MAIN
// world. Ported from the native DIG Browser; the provider relays each wallet RPC over
// window.postMessage to wireWalletBridge() below, which forwards to the background SW
// (→ WalletConnect → Sage). This gives any dapp the same `window.chia` the native
// browser injects, on Chrome/Edge/Brave/Firefox.
function injectWalletProvider() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dig-provider.js');
    script.onload = function () { try { this.remove(); } catch (e) { /* ignore */ } };
    script.onerror = function () {
      console.warn('DIG Extension: Failed to load wallet provider');
    };
    (document.head || document.documentElement).appendChild(script);
  } catch (error) {
    console.warn('DIG Extension: Error injecting wallet provider', error);
  }
}

// Bridge page-world `window.chia` requests (DIG_WALLET_REQUEST) to the background SW,
// then post the wallet's {status, body} envelope back to the page (DIG_WALLET_RESPONSE).
// The background SW supplies the calling origin's per-origin consent gate; this bridge
// only relays. window.location.origin is the committed page origin (the content script
// runs in the isolated world of the same document), so it is trustworthy for gating.
function wireWalletBridge() {
  // Both worlds share this document's origin; every inbound request is validated against it and
  // every reply is posted back with it as the targetOrigin (#73). A cross-origin/foreign-frame
  // message is dropped by parseInboundRequest; a malformed payload is dropped, never thrown on.
  const selfOrigin = window.location.origin;
  const target = postTargetOrigin(selfOrigin);
  window.addEventListener('message', (event) => {
    if (event.source !== window) return; // frame guard: only same-window messages
    const req = parseInboundRequest(event.data, event.origin, selfOrigin);
    if (!req) return;

    const reply = (envelope) => {
      window.postMessage(buildResponse(req.id, envelope), target);
    };

    try {
      chrome.runtime.sendMessage(
        {
          action: 'walletRpc',
          method: req.method,
          params: req.params,
          origin: selfOrigin,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reply({ status: -1, error: chrome.runtime.lastError.message });
            return;
          }
          // background returns { status, body } (or { status, error }).
          reply(response || { status: -1, error: 'No response from wallet broker' });
        }
      );
    } catch (e) {
      reply({ status: -1, error: e && e.message ? e.message : 'wallet bridge error' });
    }
  });
}

// Check if we're on a localhost page
function isLocalhostPage() {
  try {
    const url = window.location.href;
    return url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
  } catch (e) {
    return false;
  }
}

// Track if initial processing is complete (shared across functions)
let initialProcessingComplete = false;

// Check if we missed initial resources and need to reload
function checkForMissedResources() {
  // Use sessionStorage to prevent infinite reload loops
  const reloadKey = 'dig-extension-reloaded';
  if (sessionStorage.getItem(reloadKey)) {
    return; // Already reloaded once, don't reload again
  }
  
  // Check if there are any chia:// URLs in the DOM that weren't converted
  const hasUnconvertedDigUrls = document.querySelectorAll(
    'img[src^="chia://"], script[src^="chia://"], link[href^="chia://"], ' +
    'source[src^="chia://"], video[src^="chia://"], audio[src^="chia://"], ' +
    'iframe[src^="chia://"], object[data^="chia://"], embed[data^="chia://"]'
  ).length > 0;
  
  // Also check for chia:// in style attributes
  const hasDigInStyles = Array.from(document.querySelectorAll('[style*="chia://"]')).some(el => {
    const style = el.getAttribute('style') || '';
    return style.includes('chia://') && !style.includes('http://localhost:');
  });
  
  // Check for chia:// in style tags
  const hasDigInStyleTags = Array.from(document.querySelectorAll('style')).some(style => {
    const content = style.textContent || '';
    return content.includes('chia://') && !content.includes('http://localhost:');
  });
  
  if (hasUnconvertedDigUrls || hasDigInStyles || hasDigInStyleTags) {
    // We found unconverted chia:// URLs - we might have been too late
    // Check if page is still loading or just finished loading
    if (document.readyState === 'loading' || document.readyState === 'interactive') {
      // Page is still loading, wait a bit and check again
      setTimeout(() => {
        checkForMissedResources();
      }, 100);
    } else {
      // Page has loaded, check if we still have unconverted URLs
      const stillHasUnconverted = document.querySelectorAll(
        'img[src^="chia://"], script[src^="chia://"], link[href^="chia://"], ' +
        'source[src^="chia://"], video[src^="chia://"], audio[src^="chia://"], ' +
        'iframe[src^="chia://"], object[data^="chia://"], embed[data^="chia://"]'
      ).length > 0;
      
      if (stillHasUnconverted) {
        // Mark that we're reloading and reload once
        sessionStorage.setItem(reloadKey, 'true');
        console.log('DIG Extension: Detected missed resources, reloading page once...');
        window.location.reload();
      }
    }
  }
}

// DIG Extension Content Script v2.0
// Initialize all interceptors - run immediately, non-blocking
(function() {
  // Note: We DO want to process chia:// URLs even on localhost pages
  // (e.g., test.html served from localhost:8080 contains chia:// URLs)
  // We just need to be careful not to interfere with normal localhost requests
  
  // Debug: Log that content script is running
  console.log('DIG Extension: Content script v2.0 loaded at', new Date().toISOString());
  
  // Ensure processElementSync is accessible (it's defined at top level, but ensure it's in scope)
  const processElement = typeof processElementSync !== 'undefined' ? processElementSync : function(element) {
    // Fallback: if processElementSync isn't available, use processAllElementsImmediately
    if (element && document.documentElement) {
      processAllElementsImmediately();
    }
  };
  
  // Try to inject page script FIRST (runs in page context, can intercept earlier)
  // This is critical - it intercepts before browser loads resources
  try {
    injectPageScript();
    console.log('DIG Extension: Page script injected');
  } catch (e) {
    console.warn('DIG Extension: Failed to inject page script:', e);
    // Ignore CSP errors - we'll rely on content script
  }

  // Inject the `window.chia` wallet provider + bridge its requests to the background SW.
  try {
    wireWalletBridge();
    injectWalletProvider();
    console.log('DIG Extension: Wallet provider injected');
  } catch (e) {
    console.warn('DIG Extension: Failed to inject wallet provider:', e);
  }
  
  // Process elements IMMEDIATELY - but only chia:// URLs
  // This must run synchronously at document_start to catch resources before they load
  if (document.documentElement) {
    console.log('DIG Extension: Processing elements immediately');
    processAllElementsImmediately();
    
    // Count how many chia:// URLs we found
    const digUrls = document.querySelectorAll('[src^="chia://"], [href^="chia://"], [data^="chia://"]');
    console.log(`DIG Extension: Found ${digUrls.length} elements with chia:// URLs`);
  } else {
    console.warn('DIG Extension: document.documentElement not available yet');
  }
  
  // Set up all interceptors immediately (these are non-blocking)
  interceptDigUrls();
  interceptFetch();
  interceptXHR();
  interceptLinkClicks();
  
  // Priority 9: DOM Manipulation - MutationObserver for dynamic content
  // Watch for dynamically added elements with chia:// URLs
  const mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) { // Element node
          // Process immediately - don't wait
          // Use processElement which references processElementSync if available
          if (typeof processElementSync !== 'undefined') {
            processElementSync(node);
          } else {
            processElement(node);
          }
          
          // Handle Shadow DOM if it exists
          if (node.shadowRoot) {
            // Process shadow root content
            const shadowElements = node.shadowRoot.querySelectorAll('*');
            shadowElements.forEach(shadowEl => {
              if (typeof processElementSync !== 'undefined') {
                processElementSync(shadowEl);
              } else {
                processElement(shadowEl);
              }
            });
          }
          
          // Also check children (including in shadow DOM)
          if (node.querySelectorAll) {
            // Use valid CSS selectors - split into multiple queries to avoid invalid syntax
            const selectors = [
              'img[src^="chia://"]',
              'script[src^="chia://"]',
              'link[href^="chia://"]',
              'source[src^="chia://"]',
              'video[src^="chia://"]',
              'audio[src^="chia://"]',
              'iframe[src^="chia://"]',
              'object[data^="chia://"]',
              'embed[data^="chia://"]',
              'use[href^="chia://"]',
              'image[href^="chia://"]',
              'linearGradient[href^="chia://"]',
              'radialGradient[href^="chia://"]',
              'pattern[href^="chia://"]',
              'form[action^="chia://"]',
              'input[formaction^="chia://"]',
              'button[formaction^="chia://"]',
              'meta[content*="chia://"]'
            ];
            
            // Process each selector separately to avoid invalid selector errors
            selectors.forEach(selector => {
              try {
                const digElements = node.querySelectorAll(selector);
                digElements.forEach((el) => {
                  if (typeof processElementSync !== 'undefined') {
                    processElementSync(el);
                  } else {
                    processElement(el);
                  }
                });
              } catch (e) {
                // Ignore invalid selectors
                console.warn('DIG Extension: Invalid selector in MutationObserver:', selector, e);
              }
            });
            
            // Also check for xlink:href attributes (SVG) - need to check manually since CSS selector doesn't support namespaced attributes well
            try {
              const svgElements = node.querySelectorAll('use, image, linearGradient, radialGradient, pattern');
              svgElements.forEach((el) => {
                const xlinkHref = el.getAttribute('xlink:href');
                if (xlinkHref && xlinkHref.startsWith('chia://')) {
                  if (typeof processElementSync !== 'undefined') {
                    processElementSync(el);
                  } else {
                    processElement(el);
                  }
                }
              });
            } catch (e) {
              // Ignore errors
            }
            
            // Check for data-* attributes manually (CSS doesn't support wildcards in attribute names)
            try {
              const allElements = node.querySelectorAll('*');
              allElements.forEach((el) => {
                // Check all data-* attributes
                Array.from(el.attributes).forEach(attr => {
                  if (attr.name.startsWith('data-') && attr.value && attr.value.startsWith('chia://')) {
                    if (typeof processElementSync !== 'undefined') {
                      processElementSync(el);
                    } else {
                      processElement(el);
                    }
                  }
                });
              });
            } catch (e) {
              // Ignore errors
            }
          }
        }
      });
      
      // Also watch for attribute changes
      if (mutation.type === 'attributes' && mutation.target.nodeType === 1) {
        const element = mutation.target;
        const attr = mutation.attributeName;
        // Check common attributes and also data-* attributes
        if (attr === 'src' || attr === 'href' || attr === 'data' || attr === 'action' || 
            attr === 'formaction' || attr === 'content' || attr.startsWith('data-') ||
            attr === 'xlink:href') {
          const value = element.getAttribute(attr);
          if (value && value.startsWith('chia://')) {
            if (typeof processElementSync !== 'undefined') {
              processElementSync(element);
            } else {
              processElement(element);
            }
          }
        }
        
        // Also check style attribute changes
        if (attr === 'style') {
          const styleValue = element.getAttribute('style');
          if (styleValue && styleValue.includes('chia://')) {
            if (typeof processElementSync !== 'undefined') {
              processElementSync(element);
            } else {
              processElement(element);
            }
          }
        }
      }
      
      // Watch for Shadow DOM attachment
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1 && node.shadowRoot) {
            // New shadow root attached, process it
            const shadowElements = node.shadowRoot.querySelectorAll('*');
            shadowElements.forEach(shadowEl => {
              if (typeof processElementSync !== 'undefined') {
                processElementSync(shadowEl);
              } else {
                processElement(shadowEl);
              }
            });
          }
        });
      }
    });
  });
  
  // Listen for custom events from page script
  window.addEventListener('dig-element-added', (event) => {
    if (event.detail && event.detail.element) {
      if (typeof processElementSync !== 'undefined') {
        processElementSync(event.detail.element);
      } else {
        processElement(event.detail.element);
      }
    }
  });

  // Bridge: relay page-context chia:// proxy requests to background SW (which has WASM/RPC access)
  // page-script.js posts { type: 'DIG_PROXY_REQUEST', id, url } and awaits
  // { type: 'DIG_PROXY_RESPONSE', id, dataUrl, contentType } back.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'DIG_PROXY_REQUEST') return;
    const { id, url } = event.data;
    if (!id || !url) return;
    if (typeof url !== 'string' || !url.startsWith('chia://')) return;
    chrome.runtime.sendMessage({ action: 'proxyRequest', url }, (proxyResponse) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          type: 'DIG_PROXY_RESPONSE',
          id,
          error: chrome.runtime.lastError.message,
        }, '*');
        return;
      }
      if (!proxyResponse || proxyResponse.error) {
        window.postMessage({
          type: 'DIG_PROXY_RESPONSE',
          id,
          error: (proxyResponse && proxyResponse.error) || 'proxy failed',
        }, '*');
        return;
      }
      window.postMessage({
        type: 'DIG_PROXY_RESPONSE',
        id,
        dataUrl: proxyResponse.data,
        contentType: proxyResponse.contentType,
      }, '*');
    });
  });
  
  // Start observing DOM changes
  if (document.documentElement) {
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data', 'srcset']
    });
  }
  
  // Check extension state asynchronously and update if needed
  (async () => {
    const enabled = await isExtensionEnabled();
    
    if (!enabled) {
      // Still set up listeners, but check state dynamically
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.extensionEnabled) {
          // Re-initialize if extension is enabled
          if (changes.extensionEnabled.newValue) {
            location.reload();
          }
        }
      });
    } else {
      // Process once more when we know it's enabled (non-blocking, delayed)
      // This is the final processing pass - after this, only AJAX interceptors remain active
      setTimeout(() => {
        if (!initialProcessingComplete) {
          processAllElementsImmediately();
          initialProcessingComplete = true;
        }
      }, 100);
      
      // Check for missed resources after a delay (non-blocking)
      // This gives the page time to load and us time to process
      setTimeout(() => {
        checkForMissedResources();
      }, 200);
      
      // Check for missed resources once more after DOM is ready (non-blocking, delayed).
      // (A whole-page cache-warming preload pass used to run here; removed with the content
      // cache it existed to warm — #43 / #41 SoC audit decision 3. Resources are still
      // resolved on demand as each element is processed.)
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          setTimeout(() => {
            checkForMissedResources();
          }, 500);
        }, { once: true });
      } else {
        setTimeout(() => {
          checkForMissedResources();
        }, 500);
      }
    }
  })();
})();

