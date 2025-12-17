// Default server configuration
const DEFAULT_SERVER_URL = 'localhost';
const DEFAULT_SERVER_PORT = 8080;
const DEFAULT_SERVER_HOST = 'localhost:8080';

// Parse RPC host into URL and port
function parseServerHost(host) {
  if (!host || !host.trim()) {
    return { url: 'localhost', port: 8080 };
  }
  
  host = host.trim();
  
  // Remove protocol if present
  let url = host.replace(/^https?:\/\//, '');
  
  // Check if port is specified
  const portMatch = url.match(/:(\d+)$/);
  let port = 8080;
  
  if (portMatch) {
    port = parseInt(portMatch[1], 10);
    url = url.replace(/:\d+$/, '');
  }
  
  // Validate port
  if (port < 1 || port > 65535) {
    port = 8080;
  }
  
  // If URL is empty after parsing, use localhost
  if (!url) {
    url = 'localhost';
  }
  
  return { url, port };
}

// Get server configuration from storage
async function getServerConfig() {
  const result = await chrome.storage.local.get(['server.host', 'server.url', 'server.port']);
  
  // If new format exists, use it
  if (result['server.host']) {
    return parseServerHost(result['server.host']);
  }
  
  // Fallback to old format for backward compatibility
  return {
    url: result['server.url'] || DEFAULT_SERVER_URL,
    port: result['server.port'] || DEFAULT_SERVER_PORT
  };
}

// Convert dig:// URL to configured server URL
async function convertDigUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('dig://')) {
    return url;
  }
  
  const result = await chrome.storage.local.get(['server.host', 'server.url', 'server.port']);
  let serverHost = result['server.host'] || 'localhost:8080';
  
  // Fallback to old format for backward compatibility
  if (!result['server.host'] && (result['server.url'] || result['server.port'])) {
    const url = result['server.url'] || 'localhost';
    const port = result['server.port'] || 8080;
    serverHost = `${url}:${port}`;
  }
  
  const urlPath = url.replace(/^dig:\/\//, '');
  
  // Use the RPC host as-is - don't assume protocol or port
  // If it doesn't have a protocol, add http://
  let serverUrl = serverHost.trim();
  if (!serverUrl.includes('://')) {
    serverUrl = `http://${serverUrl}`;
  }
  
  // Remove trailing slash
  serverUrl = serverUrl.replace(/\/+$/, '');
  
  // Append the path
  return `${serverUrl}/${urlPath}`;
}

// Load extension state on startup
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['extensionEnabled']);
  if (result.extensionEnabled === undefined) {
    // Default to enabled
    await chrome.storage.local.set({ extensionEnabled: true });
  }
  
  // Check for any existing tabs with dig:// URLs (in case extension loaded after tab was opened)
  checkExistingDigTabs();
});

// Check for existing tabs with dig:// URLs and redirect them
async function checkExistingDigTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && tab.url.startsWith('dig://') && !isLocalhostUrl(tab.url)) {
        await redirectDigUrlToLocalhost(tab.id, tab.url);
      } else if (tab.pendingUrl && tab.pendingUrl.startsWith('dig://')) {
        await redirectDigUrlToLocalhost(tab.id, tab.pendingUrl);
      }
    }
  } catch (error) {
    console.error('DIG Extension: Error checking existing tabs:', error);
  }
}

// Periodically check for dig:// tabs (catches cases where we missed the initial event)
setInterval(() => {
  checkExistingDigTabs();
}, 1000); // Check every second

// Also check on startup (not just on install)
chrome.runtime.onStartup.addListener(() => {
  checkExistingDigTabs();
});

// Cache for pre-loaded resources
const resourceCache = new Map();

// Pre-load dig:// resources when page loads
async function preloadResources(digUrls) {
  const results = await Promise.allSettled(
    digUrls.map(async (digUrl) => {
      if (resourceCache.has(digUrl)) {
        return { url: digUrl, cached: true, data: resourceCache.get(digUrl) };
      }
      
      const serverUrl = await convertDigUrl(digUrl);
      
      try {
        const response = await fetch(serverUrl);
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const blob = await response.blob();
        
        // Convert to data URL
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        
        const cachedData = { data: dataUrl, contentType };
        resourceCache.set(digUrl, cachedData);
        return { url: digUrl, cached: false, data: cachedData };
      } catch (error) {
        console.error(`Failed to preload ${digUrl}:`, error);
        return { url: digUrl, error: error.message };
      }
    })
  );
  
  return results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason });
}

// Error and success reporting storage
const errorReports = [];
const successReports = [];

// Listen for messages from content script to proxy requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'toggleExtension') {
    // State is updated in popup.js, we just need to handle navigation
    console.log('Extension toggled:', message.enabled);
    return false; // Not async
  }
  
  if (message.action === 'updateServerConfig') {
    // Server configuration updated - save immediately
    console.log('Server config updated:', message.host || `${message.url}:${message.port}`);
    
    // Save in new format if provided
    const storageData = {};
    if (message.host) {
      storageData['server.host'] = message.host;
      // Also parse and save in old format for backward compatibility
      const config = parseServerHost(message.host);
      storageData['server.url'] = config.url;
      storageData['server.port'] = config.port;
    } else {
      // Old format - save both
      storageData['server.url'] = message.url || DEFAULT_SERVER_URL;
      storageData['server.port'] = message.port || DEFAULT_SERVER_PORT;
      storageData['server.host'] = `${storageData['server.url']}:${storageData['server.port']}`;
    }
    
    chrome.storage.local.set(storageData).then(() => {
      // Clear resource cache so new requests use new config
      resourceCache.clear();
      console.log('DIG Extension: Resource cache cleared, RPC host updated to:', storageData['server.host']);
      
      // Notify all tabs to update their RPC host cache
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'updateRpcHost',
            rpcHost: storageData['server.host']
          }).catch(() => {
            // Ignore errors (tab might not have content script loaded)
          });
        });
      });
    });
    
    return false; // Not async
  }
  
  if (message.action === 'reportError') {
    // Store error report
    errorReports.push({
      url: message.url,
      error: message.error,
      strategy: message.strategy,
      timestamp: message.timestamp
    });
    // Keep only last 100 errors
    if (errorReports.length > 100) {
      errorReports.shift();
    }
    return false;
  }
  
  if (message.action === 'reportSuccess') {
    // Store success report
    successReports.push({
      url: message.url,
      strategy: message.strategy,
      timestamp: message.timestamp
    });
    // Keep only last 1000 successes
    if (successReports.length > 1000) {
      successReports.shift();
    }
    return false;
  }
  
  if (message.action === 'navigate') {
    // Navigate the current tab to a URL (used for programmatic navigation)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.update(tabs[0].id, { url: message.url });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active tab found' });
      }
    });
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'preloadResources') {
    // Pre-load multiple dig:// resources
    preloadResources(message.urls || [])
      .then(results => {
        sendResponse({ success: true, results });
      })
      .catch(error => {
        sendResponse({ error: error.message });
      });
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'proxyRequest') {
    // Proxy a dig:// request through the background service worker
    const digUrl = message.url;
    if (!digUrl || !digUrl.startsWith('dig://')) {
      sendResponse({ error: 'Invalid dig:// URL' });
      return false;
    }
    
    // Check cache first
    if (resourceCache.has(digUrl)) {
      const cached = resourceCache.get(digUrl);
      sendResponse({
        success: true,
        data: cached.data,
        contentType: cached.contentType,
        cached: true
      });
      return false;
    }
    
    // Convert to configured server URL and fetch
    (async () => {
      try {
        const serverUrl = await convertDigUrl(digUrl);
        
        // Fetch the data
        const response = await fetch(serverUrl);
        
        // Check HTTP status code - reject error responses
        if (!response.ok) {
          const statusText = response.statusText || 'Unknown Error';
          const statusCode = response.status;
          
          // Try to get error message from JSON response if available
          let errorMessage = `HTTP ${statusCode} ${statusText}`;
          try {
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              const errorData = await response.json();
              if (errorData.error || errorData.message) {
                errorMessage = errorData.error || errorData.message;
              }
            }
          } catch (e) {
            // Ignore JSON parse errors, use default message
          }
          
          sendResponse({ 
            error: errorMessage,
            statusCode: statusCode,
            success: false
          });
          return;
        }
        
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const blob = await response.blob();
        
        // Convert blob to base64 data URL
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result;
          // Cache the result
          resourceCache.set(digUrl, { data: dataUrl, contentType });
          sendResponse({
            success: true,
            data: dataUrl,
            contentType: contentType,
            cached: false
          });
        };
        reader.onerror = () => {
          sendResponse({ error: 'Failed to read blob' });
        };
        reader.readAsDataURL(blob);
      } catch (error) {
        console.error('Proxy request failed:', error);
        sendResponse({ error: error.message });
      }
    })();
    
    return true; // Keep channel open for async response
  }
  
  return false;
});

// Helper to check if URL is localhost
function isLocalhostUrl(url) {
  if (!url) return false;
  try {
    const urlObj = new URL(url);
    return urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1';
  } catch (e) {
    return url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
  }
}

// Helper function to convert dig:// URL to configured server and redirect tab
async function redirectDigUrlToLocalhost(tabId, digUrl) {
  if (!digUrl || !digUrl.startsWith('dig://')) {
    return false;
  }
  
  const result = await chrome.storage.local.get(['extensionEnabled']);
  const isEnabled = result.extensionEnabled !== false; // Default to true
  
  if (!isEnabled) {
    return false;
  }
  
  // Extract path from dig:// URL and convert to configured server URL
  const serverUrl = await convertDigUrl(digUrl);
  
  try {
    // Redirect to configured server
    await chrome.tabs.update(tabId, {
      url: serverUrl
    });
    return true;
  } catch (error) {
    console.error('DIG Extension: Failed to redirect tab:', error);
    return false;
  }
}

// Handle navigation to dig:// URLs via webNavigation (for in-page navigation and address bar)
// This is the PRIMARY interceptor - catches dig:// URLs before Chrome processes them
// NOTE: For address bar navigation, Chrome may show an external protocol dialog briefly
// before the extension can intercept. This is a Chrome limitation.
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    // Skip localhost URLs - these are already redirected
    if (isLocalhostUrl(details.url)) {
      return;
    }
    
    if (details.url && details.url.startsWith('dig://')) {
      // Cancel the navigation and redirect to localhost
      // This prevents Chrome from opening a new window for external protocols
      const result = await chrome.storage.local.get(['extensionEnabled']);
      const isEnabled = result.extensionEnabled !== false;
      
      if (isEnabled) {
        // Convert dig:// URL to configured server URL
        const serverUrl = await convertDigUrl(details.url);
        
        // Use chrome.tabs.update to redirect in the CURRENT tab (not new window)
        // This works for both address bar navigation and protocol handler launches
        try {
          // For address bar navigation, use the current tab
          // For protocol handler, this might be a new tab, which is fine
          await chrome.tabs.update(details.tabId, {
            url: serverUrl
          });
          console.log('DIG Extension: Redirected dig:// URL to server:', serverUrl);
        } catch (error) {
          // If tab doesn't exist yet (protocol handler case), it will be handled by onCreated/onUpdated
          console.log('DIG Extension: Tab might not exist yet, will be handled by onCreated/onUpdated');
        }
      }
    }
  },
  { url: [{ schemes: ['dig'] }] }
);

// Also handle dig:// links clicked in pages (using content script approach)
chrome.webNavigation.onCommitted.addListener(
  async (details) => {
    // Skip localhost URLs - these are already redirected
    if (isLocalhostUrl(details.url)) {
      return;
    }
    
    if (details.url && details.url.startsWith('dig://') && details.frameId === 0) {
      // Only main frame
      await redirectDigUrlToLocalhost(details.tabId, details.url);
    }
  },
  { url: [{ schemes: ['dig'] }] }
);

// Handle tabs opened with dig:// URLs (from protocol handler, command line, or address bar)
// This catches when Chrome is launched with dig:// URL from OS protocol handler
// Also catches address bar navigation that might have been missed by onBeforeNavigate
chrome.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
    // Process when URL changes or when tab is loading
    if (changeInfo.url) {
      // URL changed - check if it's dig:// (catches address bar navigation)
      if (tab.url && tab.url.startsWith('dig://') && !isLocalhostUrl(tab.url)) {
        await redirectDigUrlToLocalhost(tabId, tab.url);
        return;
      }
    }
    
    // Also check when status changes to loading (catches initial load)
    // This is important for address bar navigation
    if (changeInfo.status === 'loading' && tab.url && tab.url.startsWith('dig://') && !isLocalhostUrl(tab.url)) {
      await redirectDigUrlToLocalhost(tabId, tab.url);
      return;
    }
    
    // Check when tab becomes complete (fallback for any missed cases)
    if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('dig://') && !isLocalhostUrl(tab.url)) {
      await redirectDigUrlToLocalhost(tabId, tab.url);
    }
    
    // Also check pendingUrl for address bar navigation (very early catch)
    if (tab.pendingUrl && tab.pendingUrl.startsWith('dig://') && !isLocalhostUrl(tab.pendingUrl)) {
      await redirectDigUrlToLocalhost(tabId, tab.pendingUrl);
    }
  }
);

// Also listen for tab creation (when new tab/window is opened with dig:// URL)
chrome.tabs.onCreated.addListener(
  async (tab) => {
    // Check if tab has a dig:// URL (might be pending or already set)
    if (tab.url && tab.url.startsWith('dig://')) {
      // URL is already set, redirect immediately
      setTimeout(async () => {
        await redirectDigUrlToLocalhost(tab.id, tab.url);
      }, 50);
    } else if (tab.pendingUrl && tab.pendingUrl.startsWith('dig://')) {
      // URL is pending, wait a bit then check again
      setTimeout(async () => {
        try {
          const updatedTab = await chrome.tabs.get(tab.id);
          if (updatedTab.url && updatedTab.url.startsWith('dig://')) {
            await redirectDigUrlToLocalhost(updatedTab.id, updatedTab.url);
          } else if (updatedTab.pendingUrl && updatedTab.pendingUrl.startsWith('dig://')) {
            await redirectDigUrlToLocalhost(updatedTab.id, updatedTab.pendingUrl);
          }
        } catch (error) {
          console.error('DIG Extension: Error handling new tab:', error);
        }
      }, 100);
    }
  }
);

