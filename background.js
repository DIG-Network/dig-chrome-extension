// Load URN utilities module first
importScripts('dig-urn.js');

// Default server configuration
const DEFAULT_SERVER_URL = 'localhost';
const DEFAULT_SERVER_PORT = 80;
const DEFAULT_SERVER_HOST = 'localhost:80';

// DIG Content Server configuration
const DIG_RPC_PORT = 3141; // DIG Node RPC port
const DIG_CONTENT_SERVER_HOST = 'dig.local'; // Content server hostname
const DIG_CONTENT_SERVER_PORT = 80; // Content server port (default HTTP)

// Base36 encoding/decoding for store IDs (64 hex chars -> max 50 base36 chars)
// Uses BigInt for handling large numbers (256-bit store IDs)
function hexToInt(hex) {
  try {
    return BigInt('0x' + hex);
  } catch (e) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
}

function intToBase36(bigInt) {
  if (bigInt === 0n) return '0';
  let result = '';
  const base = 36n;
  while (bigInt > 0n) {
    const remainder = Number(bigInt % base);
    const char = remainder < 10 
      ? remainder.toString()
      : String.fromCharCode(97 + remainder - 10); // 'a' = 97
    result = char + result;
    bigInt = bigInt / base;
  }
  return result;
}

function base36ToInt(base36) {
  let result = 0n;
  const base = 36n;
  for (let i = 0; i < base36.length; i++) {
    const char = base36[i].toLowerCase();
    let digit;
    if (char >= '0' && char <= '9') {
      digit = BigInt(parseInt(char, 10));
    } else if (char >= 'a' && char <= 'z') {
      digit = BigInt(char.charCodeAt(0) - 97 + 10);
    } else {
      throw new Error(`Invalid base36 character: ${char}`);
    }
    result = result * base + digit;
  }
  return result;
}

function intToHex(bigInt, length = 64) {
  let hex = bigInt.toString(16);
  return hex.padStart(length, '0');
}

// Encode store ID (64 hex chars) to base36 (max 50 chars)
function encodeStoreId(storeId) {
  if (!/^[a-f0-9]{64}$/i.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  const int = hexToInt(storeId);
  return intToBase36(int);
}

// Decode base36 to store ID (64 hex chars)
function decodeStoreId(encoded) {
  const int = base36ToInt(encoded);
  return intToHex(int, 64);
}

// Parse URN: urn:dig:{chain}:{storeId}:{roothash}/{resourceKey}
function parseURN(urn) {
  // Remove dig:// prefix if present
  let urnString = urn.replace(/^dig:\/\//, '');
  
  // Remove urn:dig: prefix if present
  urnString = urnString.replace(/^urn:dig:/i, '');
  
  // Parse components
  // Format: {chain}:{storeId}:{roothash}/{resourceKey}
  // or: {chain}:{storeId}/{resourceKey} (no roothash)
  const match = urnString.match(/^([^:]+):([a-f0-9]{64})(?::([a-f0-9]{64}))?(?:\/(.+))?$/i);
  
  if (!match) {
    // Try without chain prefix (assume chia)
    const simpleMatch = urnString.match(/^([a-f0-9]{64})(?::([a-f0-9]{64}))?(?:\/(.+))?$/i);
    if (simpleMatch) {
      return {
        chain: 'chia',
        storeId: simpleMatch[1].toLowerCase(),
        roothash: simpleMatch[2] ? simpleMatch[2].toLowerCase() : null,
        resourceKey: simpleMatch[3] || ''
      };
    }
    return null;
  }
  
  return {
    chain: match[1].toLowerCase(),
    storeId: match[2].toLowerCase(),
    roothash: match[3] ? match[3].toLowerCase() : null,
    resourceKey: match[4] || ''
  };
}

// Convert URN to content server URL
async function urnToContentServerUrl(urn) {
  const parsed = parseURN(urn);
  if (!parsed) {
    // If not a valid URN, return as-is (fallback to old behavior)
    return null;
  }
  
  // Check if dig.local is resolvable
  const resolvable = await isDigLocalResolvable();
  const host = resolvable ? DIG_CONTENT_SERVER_HOST : 'localhost';
  const port = resolvable ? DIG_CONTENT_SERVER_PORT : await getServerConfig().then(c => c.port);
  
  // Build the full URN string for the path
  let urnString = `urn:dig:${parsed.chain}:${parsed.storeId}`;
  if (parsed.roothash) {
    urnString += `:${parsed.roothash}`;
  }
  if (parsed.resourceKey) {
    urnString += `/${parsed.resourceKey}`;
  }
  
  // Use path-based format: http://dig.local/urn:dig:chia:...
  // The server will redirect to subdomain format if dig.local is used
  const url = `http://${host}${port !== 80 ? ':' + port : ''}/${urnString}`;
  
  return url;
}

// Make RPC call to DIG Node to get content
async function fetchContentViaRPC(urn) {
  try {
    // Remove dig:// prefix if present
    let urnString = urn.replace(/^dig:\/\//, '');
    const parsed = parseURN(urnString);
    if (!parsed) {
      throw new Error('Invalid URN format');
    }
    
    // Use the full URN string (with urn:dig: prefix)
    const fullURN = urnString.startsWith('urn:dig:') ? urnString : `urn:dig:chia:${parsed.storeId}${parsed.roothash ? ':' + parsed.roothash : ''}${parsed.resourceKey ? '/' + parsed.resourceKey : ''}`;
    
    // Use rpc.dig.local or localhost for RPC server
    // Try localhost first (for testing), can be changed to rpc.dig.local if DNS is configured
    const rpcHost = 'localhost'; // Change to 'rpc.dig.local' if DNS is configured
    const rpcUrl = `http://${rpcHost}:${DIG_RPC_PORT}/rpc`;
    
    // Make JSON-RPC call with raw URN (no hashing, no encryption)
    const rpcRequest = {
      jsonrpc: '2.0',
      method: 'getContent',
      params: {
        urn: fullURN
      },
      id: 1
    };
    
    console.log('DIG Extension: Making RPC call to:', rpcUrl, 'for URN:', fullURN.substring(0, 50) + '...');
    
    let response;
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(rpcRequest)
      });
    } catch (fetchError) {
      // Network error - RPC server might not be running
      console.error('DIG Extension: RPC fetch error (server might not be running):', fetchError);
      throw new Error(`RPC server not available: ${fetchError.message}. Make sure the RPC server is running on ${rpcUrl}`);
    }
    
    if (!response.ok) {
      throw new Error(`RPC call failed: ${response.status} ${response.statusText}`);
    }
    
    const rpcResponse = await response.json();
    
    if (rpcResponse.error) {
      throw new Error(`RPC error: ${rpcResponse.error.message || JSON.stringify(rpcResponse.error)}`);
    }
    
    // Get data URL directly from response (no encryption/decryption needed)
    const dataUrl = rpcResponse.result.dataUrl;
    
    if (!dataUrl) {
      throw new Error('RPC response missing dataUrl');
    }
    
    return {
      dataUrl: dataUrl,
      urn: urn,
      fullURN: fullURN
    };
  } catch (error) {
    console.error('DIG Extension: RPC fetch failed:', error);
    throw error;
  }
}

// Parse RPC host into URL and port
function parseServerHost(host) {
  if (!host || !host.trim()) {
    return { url: 'localhost', port: 80 };
  }
  
  host = host.trim();
  
  // Remove protocol if present
  let url = host.replace(/^https?:\/\//, '');
  
  // Check if port is specified
  const portMatch = url.match(/:(\d+)$/);
  let port = 80;
  
  if (portMatch) {
    port = parseInt(portMatch[1], 10);
    url = url.replace(/:\d+$/, '');
  }
  
  // Validate port
  if (port < 1 || port > 65535) {
    port = 80;
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

// Convert dig:// URL - ALL dig:// URLs now use RPC
// This function is kept for compatibility but all dig:// URLs should go through RPC
async function convertDigUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('dig://')) {
    return url;
  }
  
  // ALL dig:// URLs use RPC - return marker to indicate RPC should be used
  // The actual fetching will be done via fetchContentViaRPC
  return `rpc://${url}`;
}

// Rule ID for dig.local redirect (must be unique and constant)
const DIG_LOCAL_RULE_ID = 1;

// Track processed URLs to prevent infinite redirect loops
const processedUrls = new Map();
const PROCESSED_URL_TTL = 5000; // 5 seconds - URLs expire after this time

// Check if dig.local is resolvable (DNS check)
async function isDigLocalResolvable() {
  try {
    // First, check if any tab is currently on dig.local - if so, it's definitely resolvable
    try {
      const tabs = await chrome.tabs.query({ url: 'http://dig.local/*' });
      if (tabs && tabs.length > 0) {
        console.log('DIG Extension: dig.local is resolvable (tab found on dig.local)');
        return true;
      }
    } catch (e) {
      // Ignore tab query errors
      console.log('DIG Extension: Tab query error (ignored):', e);
    }
    
    // Try to fetch from dig.local with a shorter timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    
    try {
      // Use GET with no-cors mode
      // Even if we can't read the response, if the request completes, DNS resolved
      const response = await fetch('http://dig.local/', {
        method: 'GET',
        signal: controller.signal,
        mode: 'no-cors',
        cache: 'no-store'
      });
      clearTimeout(timeoutId);
      console.log('DIG Extension: dig.local is resolvable (fetch succeeded)');
      return true; // DNS resolved (even if server is down)
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Check if it's a DNS/network error
      const errorMessage = error.message || error.toString() || '';
      const errorName = error.name || '';
      
      console.log('DIG Extension: Fetch error:', errorName, errorMessage);
      
      if (errorName === 'AbortError') {
        // Timeout - try a simpler check
        console.log('DIG Extension: dig.local check timed out, trying alternative method');
        try {
          // Try creating a URL object - if it works, the domain format is valid
          const testUrl = new URL('http://dig.local/');
          // If we get here, the URL is valid - assume it might be resolvable
          console.log('DIG Extension: URL format is valid, assuming resolvable');
          return true;
        } catch (urlError) {
          console.log('DIG Extension: URL format invalid');
          return false;
        }
      }
      
      if (errorMessage.includes('Failed to fetch') || 
          errorMessage.includes('ERR_NAME_NOT_RESOLVED') ||
          errorMessage.includes('network') ||
          errorMessage.includes('DNS') ||
          errorMessage.includes('ERR_CONNECTION_REFUSED') === false) {
        // ERR_CONNECTION_REFUSED means DNS resolved but server not running - still resolvable
        if (errorMessage.includes('ERR_CONNECTION_REFUSED')) {
          console.log('DIG Extension: dig.local is resolvable (connection refused = DNS works)');
          return true;
        }
        console.log('DIG Extension: dig.local is not resolvable (DNS error)');
        return false; // DNS doesn't resolve
      }
      
      // Some other error - might be resolvable but server down or CORS issue
      console.log('DIG Extension: dig.local might be resolvable (non-DNS error):', errorMessage);
      return true; // Assume resolvable if we got past DNS
    }
  } catch (error) {
    console.error('DIG Extension: Error checking dig.local resolvability:', error);
    // On error, assume not resolvable to be safe
    return false;
  }
}

// Disabled: No subdomain redirection - dig:// URLs go directly to RPC
async function updateDigLocalRedirectRules() {
  try {
    // Remove any existing dig.local redirect rules
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const ruleExists = existingRules.some(rule => rule.id === DIG_LOCAL_RULE_ID);
    
    if (ruleExists) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [DIG_LOCAL_RULE_ID]
        });
        console.log('DIG Extension: Removed dig.local redirect rule (no subdomain redirection)');
      } catch (e) {
        console.warn('DIG Extension: Error removing old rule:', e);
      }
    }
    
    // No new rules - all dig:// URLs go directly to RPC
    return;
    
    // Add the new rule (only after ensuring old one is removed)
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [rule]
      });
      console.log('DIG Extension: Updated dig.local redirect rule to:', redirectUrl);
    } catch (e) {
      // If add fails, try removing all rules and adding again
      if (e.message && e.message.includes('unique ID')) {
        console.warn('DIG Extension: Rule ID conflict, cleaning up and retrying...');
        // Get all rules and remove any with our ID
        const allRules = await chrome.declarativeNetRequest.getDynamicRules();
        const conflictingRuleIds = allRules.filter(r => r.id === DIG_LOCAL_RULE_ID).map(r => r.id);
        if (conflictingRuleIds.length > 0) {
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: conflictingRuleIds
          });
        }
        // Now try adding again
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [rule]
        });
        console.log('DIG Extension: Successfully added dig.local redirect rule after cleanup');
      } else {
        throw e;
      }
    }
  } catch (error) {
    console.error('DIG Extension: Failed to update dig.local redirect rules:', error);
  }
}

// Load extension state on startup
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['extensionEnabled']);
  if (result.extensionEnabled === undefined) {
    // Default to enabled
    await chrome.storage.local.set({ extensionEnabled: true });
  }
  
  // Set up dig.local redirect rules
  await updateDigLocalRedirectRules();
  
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
      } else if (tab.url && isDigLocalUrl(tab.url)) {
        await redirectDigLocalToExtension(tab.id, tab.url);
      } else if (tab.pendingUrl && isDigLocalUrl(tab.pendingUrl)) {
        await redirectDigLocalToExtension(tab.id, tab.pendingUrl);
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
  updateDigLocalRedirectRules();
});

// Listen for storage changes to update rules when extension is toggled or server config changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes.extensionEnabled || changes['server.host'] || changes['server.url'] || changes['server.port']) {
      updateDigLocalRedirectRules();
    }
  }
});

// Periodically check if dig.local resolvability has changed and update rules
// This handles cases where user adds hosts file entry after extension is loaded
setInterval(async () => {
  await updateDigLocalRedirectRules();
}, 30000); // Check every 30 seconds

// Cache for pre-loaded resources
const resourceCache = new Map();

// Pre-load dig:// resources when page loads
// Now just stores server URLs instead of data URLs
async function preloadResources(digUrls) {
  const results = await Promise.allSettled(
    digUrls.map(async (digUrl) => {
      if (resourceCache.has(digUrl)) {
        return { url: digUrl, cached: true, data: resourceCache.get(digUrl) };
      }
      
      // Use RPC to get data URL
      try {
        const rpcResult = await fetchContentViaRPC(digUrl);
        const cachedData = { dataUrl: rpcResult.dataUrl, url: rpcResult.dataUrl };
        resourceCache.set(digUrl, cachedData);
        return { url: digUrl, cached: false, data: cachedData };
      } catch (error) {
        console.error(`Failed to preload ${digUrl} via RPC:`, error);
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
    // Update dig.local redirect rules based on new state
    updateDigLocalRedirectRules();
    return false; // Not async
  }
  
  if (message.action === 'checkDigLocalDNS') {
    // Check if dig.local is resolvable
    // IMPORTANT: Must return true immediately to keep channel open, then call sendResponse in async
    const handleCheckDNS = async () => {
      try {
        const resolvable = await isDigLocalResolvable();
        console.log('DIG Extension: checkDigLocalDNS result:', resolvable);
        
        try {
          sendResponse({ resolvable });
          console.log('DIG Extension: DNS check response sent successfully:', resolvable);
        } catch (e) {
          console.error('DIG Extension: Failed to send DNS check response (port may be closed):', e);
        }
        
        // Update redirect rules when DNS status changes (don't wait for this)
        updateDigLocalRedirectRules().catch(err => {
          console.error('DIG Extension: Error updating redirect rules:', err);
        });
      } catch (error) {
        console.error('DIG Extension: Error in checkDigLocalDNS:', error);
        try {
          sendResponse({ resolvable: false, error: error.message });
        } catch (e) {
          console.error('DIG Extension: Failed to send error response (port closed):', e);
        }
      }
    };
    
    // Start async handler immediately
    handleCheckDNS();
    
    // Return true to keep channel open for async response
    return true;
  }
  
  if (message.action === 'convertDigUrl') {
    // Convert dig:// URL to data URL via RPC
    (async () => {
      try {
        const digUrl = message.url;
        if (!digUrl || !digUrl.startsWith('dig://')) {
          sendResponse({ error: 'Invalid dig:// URL' });
          return;
        }
        
        // Use RPC to get data URL
        const rpcResult = await fetchContentViaRPC(digUrl);
        sendResponse({ url: rpcResult.dataUrl, dataUrl: rpcResult.dataUrl });
      } catch (error) {
        console.error('DIG Extension: Error converting URL via RPC:', error);
        sendResponse({ error: error.message });
      }
    })();
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'navigateToDigUrl') {
    // Convert dig:// URL to server URL (subdomain format) and navigate tab
    // IMPORTANT: Must return true immediately to keep channel open, then call sendResponse in async
    const handleNavigateToDigUrl = async () => {
      try {
        const digUrl = message.url;
        let tabId = sender.tab ? sender.tab.id : null;
        
        if (!tabId) {
          // Fallback: try to get active tab
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs.length === 0) {
            try {
              sendResponse({ error: 'No active tab found' });
            } catch (e) {
              console.error('DIG Extension: Failed to send response (port closed):', e);
            }
            return;
          }
          tabId = tabs[0].id;
        }
        
        console.log('DIG Extension: navigateToDigUrl requested for:', digUrl);
        console.log('DIG Extension: Tab ID:', tabId);
        
        // Redirect to dig-viewer.html (not data URL)
        await handleDigUrlNavigation(tabId, digUrl);
        
        console.log('DIG Extension: Successfully redirected to viewer');
        
        // Try to send response (may fail if navigation closed port)
        try {
          const urn = digUrl.replace(/^dig:\/\//, '');
          const viewerUrl = chrome.runtime.getURL(`dig-viewer.html?urn=${encodeURIComponent(urn)}`);
          sendResponse({ success: true, url: viewerUrl });
        } catch (e) {
          // Port may be closed due to navigation - this is expected
          console.log('DIG Extension: Response not sent (port closed by navigation, expected)');
        }
      } catch (error) {
        console.error('DIG Extension: Error in navigateToDigUrl:', error);
        try {
          sendResponse({ error: error.message });
        } catch (e) {
          console.error('DIG Extension: Failed to send error response (port closed):', e);
        }
      }
    };
    
    // Start async handler immediately
    handleNavigateToDigUrl();
    
    // Return true to keep channel open for async response
    return true;
  }
  
  if (message.action === 'navigateToDataUrl') {
    // Deprecated: Navigate to server URL instead of data URL
    // Get tab ID from sender (more reliable than querying)
    const tabId = sender.tab ? sender.tab.id : null;
    const dataUrl = message.dataUrl;
    
    // If it's actually a data URL, we can't navigate to it (browser restriction)
    // But if it's a server URL (legacy call), navigate to it
    if (dataUrl && !dataUrl.startsWith('data:')) {
      if (!tabId) {
        // Fallback: try to get active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0) {
            console.log('DIG Extension: Navigating tab', tabs[0].id, 'to server URL');
            chrome.tabs.update(tabs[0].id, { url: dataUrl });
          } else {
            console.error('DIG Extension: No active tab found for navigation');
          }
        });
        return false;
      }
      
      console.log('DIG Extension: Navigating tab', tabId, 'to server URL');
      chrome.tabs.update(tabId, { url: dataUrl }).catch(error => {
        console.error('DIG Extension: Error navigating to server URL:', error);
      });
    } else {
      console.warn('DIG Extension: navigateToDataUrl called with data URL (deprecated, use navigateToDigUrl instead)');
    }
    
    // Return false since we're not sending a response (navigation closes the port)
    return false;
  }
  
  if (message.action === 'getDataUrl') {
    // Deprecated: Return server URL instead of data URL
    // IMPORTANT: Must return true immediately to keep channel open, then call sendResponse in async
    const handleGetDataUrl = async () => {
      try {
        const digUrl = message.url;
        console.log('DIG Extension: getDataUrl requested (returning data URL from RPC):', digUrl);
        
        // Use RPC to get data URL
        const rpcResult = await fetchContentViaRPC(digUrl);
        const dataUrl = rpcResult.dataUrl;
        console.log('DIG Extension: Got data URL from RPC');
        
        // Return data URL
        try {
          sendResponse({ dataUrl: dataUrl, url: dataUrl });
        } catch (e) {
          console.error('DIG Extension: Failed to send response (port may be closed):', e);
        }
      } catch (error) {
        console.error('DIG Extension: Error getting data URL from RPC:', error);
        try {
          sendResponse({ error: error.message });
        } catch (e) {
          console.error('DIG Extension: Failed to send error response (port closed):', e);
        }
      }
    };
    
    // Start async handler immediately
    handleGetDataUrl();
    
    // Return true to keep channel open for async response
    return true;
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
      
      // Update dig.local redirect rules with new server config
      updateDigLocalRedirectRules();
      
      // Notify all tabs to update their RPC host cache
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id && chrome.tabs && chrome.tabs.sendMessage) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'updateRpcHost',
              rpcHost: storageData['server.host']
            }).catch(() => {
              // Ignore errors (tab might not have content script loaded)
            });
          }
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
    // PRIMARY: Use RPC to fetch content
    // FALLBACK: Use content server for legacy/test URLs
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
    
    // Fetch via RPC or content server
    (async () => {
      try {
        // Parse URN to determine if we should use RPC
        const urnString = digUrl.replace(/^dig:\/\//, '');
        const parsed = parseURN(urnString);
        
        if (parsed) {
          // Valid URN - use RPC
          console.log('DIG Extension: Fetching via RPC for URN:', urnString.substring(0, 50) + '...');
          const rpcResult = await fetchContentViaRPC(digUrl);
          
          // RPC returns data URL directly
          const dataUrl = rpcResult.dataUrl;
          
          // Extract content type from data URL
          const contentTypeMatch = dataUrl.match(/^data:([^;]+)/);
          const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
          
          // Cache the result
          resourceCache.set(digUrl, { data: dataUrl, contentType });
          
          sendResponse({
            success: true,
            data: dataUrl,
            contentType: contentType,
            cached: false
          });
          return;
        }
        
        // Not a valid URN - still try RPC (RPC server will return decoy or error)
        console.log('DIG Extension: Invalid URN format, trying RPC anyway:', digUrl);
        try {
          const rpcResult = await fetchContentViaRPC(digUrl);
          const dataUrl = rpcResult.dataUrl;
          const contentTypeMatch = dataUrl.match(/^data:([^;]+)/);
          const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
          
          resourceCache.set(digUrl, { data: dataUrl, contentType });
          
          sendResponse({
            success: true,
            data: dataUrl,
            contentType: contentType,
            cached: false
          });
          return;
        } catch (rpcError) {
          console.error('DIG Extension: RPC failed for invalid URN:', rpcError);
          sendResponse({
            error: `Invalid URN format: ${rpcError.message}`,
            success: false
          });
          return;
        }
      } catch (error) {
        console.error('DIG Extension: Proxy request failed:', error);
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

// Helper to check if URL is dig.local (including subdomains)
function isDigLocalUrl(url) {
  if (!url) return false;
  try {
    // Normalize URL - add protocol if missing
    let normalizedUrl = url;
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://') && !normalizedUrl.startsWith('chrome-extension://')) {
      normalizedUrl = 'http://' + normalizedUrl;
    }
    const urlObj = new URL(normalizedUrl);
    // Check if hostname is dig.local or *.dig.local
    return urlObj.hostname === 'dig.local' || urlObj.hostname.endsWith('.dig.local');
  } catch (e) {
    // Fallback: check if it contains dig.local
    return url.includes('dig.local') && !url.includes('chrome-extension://');
  }
}

// Resolve dig.local subdomain URL back to URN
// Removed: No subdomain redirection - dig:// URLs go directly to RPC
// function resolveSubdomainToURN(url) { ... }

// Handle dig:// URL navigation by fetching content and streaming as data URL
// while keeping dig:// in the address bar
// Simple function to redirect to dig-viewer.html with URN
async function redirectToViewer(tabId, digUrl) {
  console.log('DIG Extension: redirectToViewer called with:', digUrl);
  
  // Extract URN from dig:// URL (remove dig:// prefix)
  const urn = digUrl.replace(/^dig:\/\//, '');
  
  // Construct viewer URL with URN parameter
  const viewerUrl = chrome.runtime.getURL(`dig-viewer.html?urn=${encodeURIComponent(urn)}`);
  
  console.log('DIG Extension: Redirecting to viewer:', viewerUrl);
  
  // Redirect to viewer page
  await chrome.tabs.update(tabId, {
    url: viewerUrl
  });
  
  console.log('DIG Extension: Successfully redirected to viewer');
}

async function handleDigUrlNavigation(tabId, digUrl) {
  console.log('DIG Extension: handleDigUrlNavigation called with:', digUrl);
  
  // Check if we've already processed this URL recently (prevent loops)
  const urlKey = `${tabId}:${digUrl}`;
  const lastProcessed = processedUrls.get(urlKey);
  if (lastProcessed && (Date.now() - lastProcessed) < PROCESSED_URL_TTL) {
    console.log('DIG Extension: URL already processed recently, skipping to prevent loop:', digUrl);
    return;
  }
  
  // Mark this URL as processed
  processedUrls.set(urlKey, Date.now());
  
  // Clean up old entries periodically
  if (processedUrls.size > 100) {
    const now = Date.now();
    for (const [key, timestamp] of processedUrls.entries()) {
      if (now - timestamp > PROCESSED_URL_TTL) {
        processedUrls.delete(key);
      }
    }
  }
  
  try {
    // Extract URN from dig:// URL (remove dig:// prefix)
    const urn = digUrl.replace(/^dig:\/\//, '');
    
    // Redirect to dig-viewer.html with URN parameter
    // The viewer will fetch content via RPC and embed it
    const viewerUrl = chrome.runtime.getURL(`dig-viewer.html?urn=${encodeURIComponent(urn)}`);
    
    console.log('DIG Extension: Redirecting to viewer:', viewerUrl);
    
    // Navigate to viewer page
    await chrome.tabs.update(tabId, {
      url: viewerUrl
    });
    
    console.log('DIG Extension: Successfully redirected to viewer');
  } catch (error) {
    console.error('DIG Extension: Error in handleDigUrlNavigation:', error);
    // Show error page
    const errorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <title>DIG Network Error</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; background: #1a0a2e; color: white; }
    .error { color: #ff6b6b; }
  </style>
</head>
<body>
  <h1 class="error">Failed to load DIG content</h1>
  <p>URL: ${digUrl}</p>
  <p>Error: ${error.message}</p>
</body>
</html>
    `)}`;
    await chrome.tabs.update(tabId, { url: errorPage });
  }
}

// Helper function to convert dig:// URL and redirect to viewer
// This is now just a wrapper around handleDigUrlNavigation
async function redirectDigUrlToLocalhost(tabId, digUrl) {
  if (!digUrl || !digUrl.startsWith('dig://')) {
    return false;
  }
  
  console.log('DIG Extension: redirectDigUrlToLocalhost called with:', digUrl);
  
  const result = await chrome.storage.local.get(['extensionEnabled']);
  const isEnabled = result.extensionEnabled !== false; // Default to true
  
  if (!isEnabled) {
    console.log('DIG Extension: Extension is disabled');
    return false;
  }
  
  // Use handleDigUrlNavigation which redirects to dig-viewer.html
  try {
    await handleDigUrlNavigation(tabId, digUrl);
    console.log('DIG Extension: Successfully redirected to viewer');
    return true;
  } catch (error) {
    console.error('DIG Extension: Failed to redirect to viewer:', error);
    return false;
  }
}

// Helper function to redirect dig.local to content server
// Disabled: No subdomain redirection - dig:// URLs go directly to RPC
async function redirectDigLocalToExtension(tabId, digLocalUrl) {
  // No-op: All dig:// URLs should go directly to RPC, no subdomain conversion
  return false;
}

// Handle navigation to dig:// URLs via webNavigation (for in-page navigation and address bar)
// This is the PRIMARY interceptor - catches dig:// URLs before Chrome processes them
// NOTE: For address bar navigation, Chrome may show an external protocol dialog briefly
// before the extension can intercept. This is a Chrome limitation.
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    // Skip data URLs - these are final destinations, don't intercept
    if (details.url && details.url.startsWith('data:')) {
      return;
    }
    
    // Skip chrome-extension:// URLs for the viewer page - these are internal
    if (details.url && details.url.includes('dig-viewer.html')) {
      return;
    }
    
    // Skip localhost URLs - these are already redirected
    if (isLocalhostUrl(details.url)) {
      return;
    }
    
    // Handle dig:// URLs - fetch content and stream as data URL while keeping dig:// in URL bar
    if (details.url && details.url.startsWith('dig://')) {
      console.log('DIG Extension: onBeforeNavigate caught dig:// URL:', details.url);
      const enabledResult = await chrome.storage.local.get(['extensionEnabled']);
      const isEnabled = enabledResult.extensionEnabled !== false;
      
      if (isEnabled) {
        // Interrupt navigation and fetch content to stream as data URL
        try {
          // Cancel the current navigation by redirecting immediately
          // Use handleDigUrlNavigation which loads as data URL and keeps dig:// in URL bar
          await handleDigUrlNavigation(details.tabId, details.url);
        } catch (error) {
          console.error('DIG Extension: Error handling dig:// navigation:', error);
          // Show error page if RPC fails
          const errorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <title>DIG Network Error</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; background: #1a0a2e; color: white; }
    .error { color: #ff6b6b; }
  </style>
</head>
<body>
  <h1 class="error">Failed to load DIG content</h1>
  <p>URL: ${details.url}</p>
  <p>Error: ${error.message}</p>
</body>
</html>
          `)}`;
          await chrome.tabs.update(details.tabId, { url: errorPage });
        }
      } else {
        console.log('DIG Extension: Extension is disabled, not redirecting');
      }
      return;
    }
    
    // Also check for Google search pages with dig:// in query (catch before page loads)
    // IMPORTANT: Skip if we're already navigating to a data URL, dig.local, or viewer to prevent loops
    if (details.url && details.frameId === 0 && 
        !details.url.startsWith('data:') && 
        !isDigLocalUrl(details.url) &&
        !details.url.includes('dig-viewer.html')) {
      const searchEngines = ['google.com/search', 'www.google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
      const isSearchPage = searchEngines.some(engine => details.url.includes(engine));
      
      if (isSearchPage) {
        try {
          const urlObj = new URL(details.url);
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
              const digMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
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
              const finalMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
              if (finalMatch) {
                digUrl = finalMatch[0];
              }
            }
            
            if (digUrl) {
              // Check if we've already processed this to prevent loops
              const urlKey = `${details.tabId}:${digUrl}`;
              const lastProcessed = processedUrls.get(urlKey);
              if (lastProcessed && (Date.now() - lastProcessed) < PROCESSED_URL_TTL) {
                console.log('DIG Extension: Already processing this dig:// URL, skipping to prevent loop');
                return;
              }
              
              console.log('DIG Extension: onBeforeNavigate detected dig:// in search, immediately replacing:', digUrl);
              const searchEnabledResult = await chrome.storage.local.get(['extensionEnabled']);
              const isEnabled = searchEnabledResult.extensionEnabled !== false;
              
              if (isEnabled) {
                try {
                  await handleDigUrlNavigation(details.tabId, digUrl);
                  return; // Exit early
                } catch (error) {
                  console.error('DIG Extension: Error in onBeforeNavigate handleDigUrlNavigation:', error);
                  await redirectDigUrlToLocalhost(details.tabId, digUrl);
                  return;
                }
              }
            }
          }
        } catch (e) {
          // Ignore errors
        }
      }
    }
    
    // Handle dig.local URLs - redirect to extension test site BEFORE DNS resolution
    if (details.url && isDigLocalUrl(details.url)) {
      const digLocalEnabledResult = await chrome.storage.local.get(['extensionEnabled']);
      const isEnabled = digLocalEnabledResult.extensionEnabled !== false;
      
      if (isEnabled) {
        // Redirect immediately before DNS resolution fails
        await redirectDigLocalToExtension(details.tabId, details.url);
      }
      return;
    }
  },
  { url: [{ schemes: ['dig', 'http', 'https'] }] }
);

// Also handle dig:// links clicked in pages (using content script approach)
chrome.webNavigation.onCommitted.addListener(
  async (details) => {
    // Skip data URLs - these are final destinations, don't intercept
    if (details.url && details.url.startsWith('data:')) {
      return;
    }
    
    // Skip chrome-extension:// URLs for the viewer page - these are internal
    if (details.url && details.url.includes('dig-viewer.html')) {
      return;
    }
    
    // Skip localhost URLs - these are already redirected
    if (isLocalhostUrl(details.url)) {
      return;
    }
    
    if (details.url && details.url.startsWith('dig://') && details.frameId === 0) {
      // Only main frame - use handleDigUrlNavigation to load as data URL
      try {
        await handleDigUrlNavigation(details.tabId, details.url);
      } catch (error) {
        console.error('DIG Extension: Error in onCommitted handleDigUrlNavigation:', error);
        await redirectDigUrlToLocalhost(details.tabId, details.url);
      }
      return;
    }
    
    // Handle dig.local URLs - redirect to content server (fallback for onCommitted)
    if (details.url && isDigLocalUrl(details.url) && details.frameId === 0) {
      await redirectDigLocalToExtension(details.tabId, details.url);
    }
    
    // Aggressively catch Google search pages with dig:// in query and redirect immediately
    // This replaces the Google search page with the dig-viewer.html
    // IMPORTANT: Skip if we're already on a data URL, dig.local, or viewer to prevent loops
    if (details.url && details.frameId === 0 && 
        !details.url.startsWith('data:') && 
        !isDigLocalUrl(details.url) &&
        !details.url.includes('dig-viewer.html')) {
      const searchEngines = ['google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
      const isSearchPage = searchEngines.some(engine => details.url.includes(engine));
      
      if (isSearchPage) {
        try {
          const urlObj = new URL(details.url);
          const queryParams = ['q', 'query', 'text', 'p', 'wd'];
          let query = null;
          
          for (const param of queryParams) {
            query = urlObj.searchParams.get(param);
            if (query) break;
          }
          
          if (query) {
            // URLSearchParams.get() automatically decodes, but handle both encoded and decoded cases
            // Try to find dig:// URL in the query (might be URL-encoded or plain)
            let digUrl = null;
            
            // Try multiple decoding passes (Google may double-encode)
            let decodedQuery = query;
            for (let i = 0; i < 3; i++) {
              // First try direct match
              const digMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
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
              const finalMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
              if (finalMatch) {
                digUrl = finalMatch[0];
              }
            }
            
            if (digUrl) {
              // Check if we've already processed this to prevent loops
              const urlKey = `${details.tabId}:${digUrl}`;
              const lastProcessed = processedUrls.get(urlKey);
              if (lastProcessed && (Date.now() - lastProcessed) < PROCESSED_URL_TTL) {
                console.log('DIG Extension: Already processing this dig:// URL in onCommitted, skipping to prevent loop');
                return;
              }
              
              console.log('DIG Extension: onCommitted detected dig:// in search query, redirecting to viewer:', digUrl);
              // Use handleDigUrlNavigation to redirect to dig-viewer.html
              try {
                await handleDigUrlNavigation(details.tabId, digUrl);
                console.log('DIG Extension: Successfully redirected from Google search to viewer');
                return; // Exit early to prevent further processing
              } catch (error) {
                console.error('DIG Extension: Error in onCommitted handleDigUrlNavigation:', error);
                return;
              }
            }
          }
        } catch (e) {
          console.warn('DIG Extension: Error parsing search URL:', e);
        }
      }
    }
  },
  { url: [{ schemes: ['dig', 'http', 'https'] }] }
);

// Handle tabs opened with dig:// URLs (from protocol handler, command line, or address bar)
// This catches when Chrome is launched with dig:// URL from OS protocol handler
// Also catches address bar navigation that might have been missed by onBeforeNavigate
chrome.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
    // Skip data URLs - these are final destinations, don't intercept
    if (tab.url && tab.url.startsWith('data:')) {
      return;
    }
    if (tab.pendingUrl && tab.pendingUrl.startsWith('data:')) {
      return;
    }
    
    // Skip chrome-extension:// URLs for the viewer page - these are internal
    if (tab.url && tab.url.includes('dig-viewer.html')) {
      return;
    }
    if (tab.pendingUrl && tab.pendingUrl.includes('dig-viewer.html')) {
      return;
    }
    
    // Process when URL changes or when tab is loading
    if (changeInfo.url) {
      // URL changed - check if it's dig:// (catches address bar navigation)
      if (tab.url && tab.url.startsWith('dig://') && !isLocalhostUrl(tab.url)) {
        await handleDigUrlNavigation(tabId, tab.url);
        return;
      }
      
      // Check if it's dig.local
      if (tab.url && isDigLocalUrl(tab.url)) {
        await redirectDigLocalToExtension(tabId, tab.url);
        return;
      }
    }
    
    // Also check when status changes to loading (catches initial load)
    // This is important for address bar navigation
    if (changeInfo.status === 'loading') {
      if (tab.url && tab.url.startsWith('dig://') && !isLocalhostUrl(tab.url)) {
        await handleDigUrlNavigation(tabId, tab.url);
        return;
      }
      
      // Check if it's dig.local
      if (tab.url && isDigLocalUrl(tab.url)) {
        await redirectDigLocalToExtension(tabId, tab.url);
        return;
      }
      
      // Also check if it's a search page with dig:// in URL (very early catch)
      if (tab.url && !tab.url.includes('dig-viewer.html')) {
        const searchEngines = ['google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
        const isSearchPage = searchEngines.some(engine => tab.url.includes(engine));
        if (isSearchPage) {
          try {
            const urlObj = new URL(tab.url);
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
                const digMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
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
                const finalMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
                if (finalMatch) {
                  digUrl = finalMatch[0];
                }
              }
              
              if (digUrl) {
                console.log('DIG Extension: Early detection of dig:// in search (tabs.onUpdated), redirecting to viewer:', digUrl);
                try {
                  await handleDigUrlNavigation(tabId, digUrl);
                  return;
                } catch (error) {
                  console.error('DIG Extension: Error redirecting from search:', error);
                }
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }
      }
    }
    
    // Check when tab becomes complete (fallback for any missed cases)
    if (changeInfo.status === 'complete') {
      if (tab.url && tab.url.startsWith('dig://') && !isLocalhostUrl(tab.url)) {
        await handleDigUrlNavigation(tabId, tab.url);
        return;
      }
      
      // Also check for Google search pages when tab completes (final fallback)
      if (tab.url && !tab.url.includes('dig-viewer.html') && !tab.url.startsWith('data:')) {
        const searchEngines = ['google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
        const isSearchPage = searchEngines.some(engine => tab.url.includes(engine));
        if (isSearchPage) {
          try {
            const urlObj = new URL(tab.url);
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
                const digMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
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
                const finalMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
                if (finalMatch) {
                  digUrl = finalMatch[0];
                }
              }
              
              if (digUrl) {
                console.log('DIG Extension: Final fallback - detected dig:// in completed search page, redirecting to viewer:', digUrl);
                try {
                  await handleDigUrlNavigation(tabId, digUrl);
                  return;
                } catch (error) {
                  console.error('DIG Extension: Error in final fallback redirect:', error);
                }
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }
      }
      
      // Check if it's dig.local
      if (tab.url && isDigLocalUrl(tab.url)) {
        await redirectDigLocalToExtension(tabId, tab.url);
      }
    }
    
    // Also check pendingUrl for address bar navigation (very early catch)
    if (tab.pendingUrl) {
      if (tab.pendingUrl.startsWith('dig://') && !isLocalhostUrl(tab.pendingUrl)) {
        // Use handleDigUrlNavigation to load as data URL
        try {
          await handleDigUrlNavigation(tabId, tab.pendingUrl);
        } catch (error) {
          console.error('DIG Extension: Error in pendingUrl handleDigUrlNavigation:', error);
          await redirectDigUrlToLocalhost(tabId, tab.pendingUrl);
        }
        return;
      }
      
      // Check if it's dig.local
      if (isDigLocalUrl(tab.pendingUrl)) {
        await redirectDigLocalToExtension(tabId, tab.pendingUrl);
      }
    }
  }
);

// Also listen for tab creation (when new tab/window is opened with dig:// URL)
chrome.tabs.onCreated.addListener(
  async (tab) => {
    // Skip data URLs - these are final destinations
    if (tab.url && tab.url.startsWith('data:')) {
      return;
    }
    if (tab.pendingUrl && tab.pendingUrl.startsWith('data:')) {
      return;
    }
    
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
          // Skip if it's now a data URL
          if (updatedTab.url && updatedTab.url.startsWith('data:')) {
            return;
          }
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
    
    // Check if tab has a dig.local URL
    if (tab.url && isDigLocalUrl(tab.url)) {
      setTimeout(async () => {
        await redirectDigLocalToExtension(tab.id, tab.url);
      }, 50);
    } else if (tab.pendingUrl && isDigLocalUrl(tab.pendingUrl)) {
      setTimeout(async () => {
        try {
          const updatedTab = await chrome.tabs.get(tab.id);
          if (updatedTab.url && isDigLocalUrl(updatedTab.url)) {
            await redirectDigLocalToExtension(updatedTab.id, updatedTab.url);
          } else if (updatedTab.pendingUrl && isDigLocalUrl(updatedTab.pendingUrl)) {
            await redirectDigLocalToExtension(updatedTab.id, updatedTab.pendingUrl);
          }
        } catch (error) {
          console.error('DIG Extension: Error handling new tab:', error);
        }
      }, 100);
    }
  }
);

// Catch DNS errors for dig.local and protocol errors for dig://
chrome.webNavigation.onErrorOccurred.addListener(
  async (details) => {
    // Skip data URLs - these are final destinations
    if (details.url && details.url.startsWith('data:')) {
      return;
    }
    
    // Check if this is a DNS error for dig.local
    if ((details.error === 'net::ERR_NAME_NOT_RESOLVED' || details.error === 'net::ERR_NAME_RESOLUTION_FAILED') && details.frameId === 0) {
      if (details.url && isDigLocalUrl(details.url)) {
        console.log('DIG Extension: Caught DNS error for dig.local, redirecting to content server');
        await redirectDigLocalToExtension(details.tabId, details.url);
      }
    }
    
    // Check if this is a protocol error for dig:// (Chrome redirecting to search)
    // Errors like ERR_UNKNOWN_URL_SCHEME indicate Chrome doesn't recognize the protocol
    if ((details.error === 'net::ERR_UNKNOWN_URL_SCHEME' || 
         details.error === 'net::ERR_INVALID_URL' ||
         details.error === 'net::ERR_FAILED') && 
        details.frameId === 0) {
      if (details.url && details.url.startsWith('dig://')) {
        console.log('DIG Extension: Caught protocol error for dig://, redirecting:', details.url);
        try {
          await handleDigUrlNavigation(details.tabId, details.url);
        } catch (error) {
          console.error('DIG Extension: Error in onErrorOccurred handleDigUrlNavigation:', error);
          await redirectDigUrlToLocalhost(details.tabId, details.url);
        }
      }
    }
  }
);

// Also add a more aggressive check - monitor tabs for dig:// and dig.local attempts
// This catches cases where navigation fails before onBeforeNavigate fires
// Also catches when Chrome treats dig:// URLs as search queries
setInterval(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      // Check pendingUrl for dig:// or dig.local (catches address bar input)
      if (tab.pendingUrl) {
        if (tab.pendingUrl.startsWith('dig://')) {
          // Use handleDigUrlNavigation to load as data URL
          try {
            await handleDigUrlNavigation(tab.id, tab.pendingUrl);
          } catch (error) {
            console.error('DIG Extension: Error in interval pendingUrl handleDigUrlNavigation:', error);
            await redirectDigUrlToLocalhost(tab.id, tab.pendingUrl);
          }
          continue;
        }
        if (isDigLocalUrl(tab.pendingUrl)) {
          await redirectDigLocalToExtension(tab.id, tab.pendingUrl);
          continue;
        }
      }
      
      // Check if current URL is a search engine page with dig:// in the query
      // Support Google, Bing, DuckDuckGo, Yahoo, and other search engines
      // IMPORTANT: Skip if we're already on a data URL or dig.local to prevent loops
      if (tab.url && !tab.url.startsWith('data:') && !isDigLocalUrl(tab.url)) {
        const searchEngines = [
          'google.com/search',
          'bing.com/search',
          'duckduckgo.com',
          'yahoo.com/search',
          'search.yahoo.com',
          'yandex.com/search',
          'baidu.com/s'
        ];
        
        const isSearchPage = searchEngines.some(engine => tab.url.includes(engine));
        
        if (isSearchPage) {
          try {
            const urlObj = new URL(tab.url);
            // Try different query parameter names used by different search engines
            const queryParams = ['q', 'query', 'text', 'p', 'wd'];
            let query = null;
            
            for (const param of queryParams) {
              query = urlObj.searchParams.get(param);
              if (query) break;
            }
            
            if (query) {
              // Extract dig:// URL from query (might be anywhere in the query string)
              // Handle both URL-encoded and plain text
              let digUrl = null;
              
              // First try direct match (already decoded by searchParams.get)
              const digMatch = query.match(/dig:\/\/[^\s"']+/);
              if (digMatch) {
                digUrl = digMatch[0];
              } else {
                // Try URL-decoding the entire query in case it's double-encoded
                try {
                  const decodedQuery = decodeURIComponent(query);
                  const decodedMatch = decodedQuery.match(/dig:\/\/[^\s"']+/);
                  if (decodedMatch) {
                    digUrl = decodedMatch[0];
                  }
                } catch (e) {
                  // Already decoded or invalid encoding
                }
              }
              
              // Also check if the entire query IS a dig:// URL (Chrome might have encoded it)
              if (!digUrl && query.includes('dig%3A%2F%2F')) {
                try {
                  const decoded = decodeURIComponent(query);
                  if (decoded.startsWith('dig://')) {
                    digUrl = decoded;
                  }
                } catch (e) {
                  // Ignore decode errors
                }
              }
              
              // Also check if query contains urn:dig: pattern (might be the URN without dig:// prefix)
              if (!digUrl) {
                const urnMatch = query.match(/urn:dig:[^\s"']+/);
                if (urnMatch) {
                  digUrl = 'dig://' + urnMatch[0];
                } else {
                  // Try URL-decoded version
                  try {
                    const decodedQuery = decodeURIComponent(query);
                    const decodedUrnMatch = decodedQuery.match(/urn:dig:[^\s"']+/);
                    if (decodedUrnMatch) {
                      digUrl = 'dig://' + decodedUrnMatch[0];
                    }
                  } catch (e) {
                    // Ignore
                  }
                }
              }
              
              if (digUrl) {
                // Check if we've already processed this to prevent loops
                const urlKey = `${tab.id}:${digUrl}`;
                const lastProcessed = processedUrls.get(urlKey);
                if (lastProcessed && (Date.now() - lastProcessed) < PROCESSED_URL_TTL) {
                  console.log('DIG Extension: Already processing this dig:// URL in interval check, skipping to prevent loop');
                  continue;
                }
                
                console.log('DIG Extension: Interval check detected dig:// URL in search query, redirecting to dig.local:', digUrl);
                // Use handleDigUrlNavigation to convert to dig.local URL
                try {
                  await handleDigUrlNavigation(tab.id, digUrl);
                  console.log('DIG Extension: Successfully replaced search page with dig:// content');
                } catch (error) {
                  console.error('DIG Extension: Error in interval handleDigUrlNavigation:', error);
                  await redirectDigUrlToLocalhost(tab.id, digUrl);
                }
                continue;
              }
            }
          } catch (e) {
            // Ignore URL parsing errors
          }
        }
      }
      
      // Check if URL contains dig.local (might be in error state)
      if (tab.url && tab.url.includes('dig.local') && !tab.url.startsWith('chrome-extension://')) {
        // Make sure it's a dig.local URL, not just containing the text
        try {
          const urlObj = new URL(tab.url);
          if (urlObj.hostname === 'dig.local') {
            await redirectDigLocalToExtension(tab.id, tab.url);
          }
        } catch (e) {
          // If URL parsing fails, try to construct a proper dig.local URL
          if (tab.url.includes('dig.local')) {
            const digLocalUrl = tab.url.startsWith('http') ? tab.url : `http://${tab.url}`;
            if (isDigLocalUrl(digLocalUrl)) {
              await redirectDigLocalToExtension(tab.id, digLocalUrl);
            }
          }
        }
      }
      
      // Also check if URL contains dig:// (might be in error or search state)
      if (tab.url && tab.url.includes('dig://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('dig://')) {
        // Try to extract dig:// URL from the current URL
        const digMatch = tab.url.match(/dig:\/\/[^\s"']+/);
        if (digMatch) {
          const digUrl = digMatch[0];
          console.log('DIG Extension: Detected dig:// URL in current page, redirecting:', digUrl);
          await redirectDigUrlToLocalhost(tab.id, digUrl);
        }
      }
    }
  } catch (error) {
    // Ignore errors
  }
}, 100); // Check every 100ms (very frequent to catch Google search immediately)

// Omnibox handler - allows users to type "dig" followed by URN or search query in address bar
chrome.omnibox.onInputEntered.addListener(
  async (text, disposition) => {
    console.log('DIG Extension: Omnibox input received:', text);
    
    const trimmedText = text.trim();
    
    // Check if it's a dig:// URL or URN
    if (trimmedText.startsWith('dig://') || trimmedText.startsWith('urn:dig:') || /^[a-f0-9]{64}/i.test(trimmedText)) {
      // Handle as dig:// URL
      let digUrl = trimmedText;
      
      // If it doesn't start with dig://, add it
      if (!digUrl.startsWith('dig://')) {
        // If it starts with "urn:dig:", add "dig://" prefix
        if (digUrl.startsWith('urn:dig:')) {
          digUrl = 'dig://' + digUrl;
        } else {
          // Otherwise, assume it's a URN and add both prefixes
          digUrl = 'dig://urn:dig:' + digUrl;
        }
      }
      
      console.log('DIG Extension: Omnibox converted to:', digUrl);
      
      // Get the current tab or create a new one based on disposition
      if (disposition === 'currentTab') {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          await redirectDigUrlToLocalhost(tabs[0].id, digUrl);
        }
      } else {
        // Open in new tab - use RPC to get data URL
        try {
          const rpcResult = await fetchContentViaRPC(digUrl);
          await chrome.tabs.create({ url: rpcResult.dataUrl });
        } catch (error) {
          console.error('DIG Extension: RPC failed for new tab:', error);
          // Fallback: show error page
          const errorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <title>DIG Network Error</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; background: #1a0a2e; color: white; }
    .error { color: #ff6b6b; }
  </style>
</head>
<body>
  <h1 class="error">Failed to load DIG content</h1>
  <p>URL: ${digUrl}</p>
  <p>Error: ${error.message}</p>
</body>
</html>
          `)}`;
          await chrome.tabs.create({ url: errorPage });
        }
      }
    } else {
      // Handle as search query - use custom search engine if enabled
      const result = await chrome.storage.local.get(['search.enabled', 'search.url']);
      const searchEnabled = result['search.enabled'] !== false;
      
      if (searchEnabled && result['search.url']) {
        // Use custom search URL
        const searchUrl = result['search.url'].replace('%s', encodeURIComponent(trimmedText));
        console.log('DIG Extension: Omnibox search query:', trimmedText, '->', searchUrl);
        
        if (disposition === 'currentTab') {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]) {
            await chrome.tabs.update(tabs[0].id, { url: searchUrl });
          }
        } else {
          await chrome.tabs.create({ url: searchUrl });
        }
      } else {
        // Fallback: try to use Chrome's search API
        try {
          const searchUrl = await getSearchUrl();
          const finalUrl = searchUrl.replace('%s', encodeURIComponent(trimmedText));
          
          if (disposition === 'currentTab') {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) {
              await chrome.tabs.update(tabs[0].id, { url: finalUrl });
            }
          } else {
            await chrome.tabs.create({ url: finalUrl });
          }
        } catch (error) {
          console.error('DIG Extension: Failed to handle search query:', error);
          // Last resort: use Google
          const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(trimmedText)}`;
          if (disposition === 'currentTab') {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) {
              await chrome.tabs.update(tabs[0].id, { url: googleUrl });
            }
          } else {
            await chrome.tabs.create({ url: googleUrl });
          }
        }
      }
    }
  }
);

// Also provide suggestions as user types
chrome.omnibox.onInputChanged.addListener(
  async (text, suggest) => {
    // Provide helpful suggestions
    const suggestions = [];
    
    if (text.trim().length === 0) {
      suggestions.push({
        content: 'dig://urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/',
        description: 'Example: dig://urn:dig:chia:.../resource'
      });
    } else {
      // If user is typing a URN, suggest the full dig:// URL
      let suggestedUrl = text.trim();
      if (!suggestedUrl.startsWith('dig://')) {
        if (suggestedUrl.startsWith('urn:dig:')) {
          suggestedUrl = 'dig://' + suggestedUrl;
        } else {
          suggestedUrl = 'dig://urn:dig:' + suggestedUrl;
        }
      }
      
      suggestions.push({
        content: suggestedUrl,
        description: `Open: ${suggestedUrl}`
      });
    }
    
    suggest(suggestions);
  }
);

// ============================================================================
// Search Engine Management
// ============================================================================

// Default search engine configuration
const DEFAULT_SEARCH_ENGINE = {
  name: 'DIG Network Search',
  keyword: 'dig',
  faviconUrl: chrome.runtime.getURL('src/favicon.png'),
  searchUrl: 'http://dig.local?urn=%s' // Default to dig.local with URN parameter
};

// Get custom search URL from storage or use default
async function getSearchUrl() {
  const result = await chrome.storage.local.get(['search.url', 'search.enabled']);
  if (result['search.enabled'] && result['search.url']) {
    return result['search.url'];
  }
  return DEFAULT_SEARCH_ENGINE.searchUrl;
}

// Add or update custom search engine
async function addCustomSearchEngine() {
  try {
    // Check if chrome.search API is available
    if (!chrome.search || typeof chrome.search.get !== 'function') {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }
    
    const searchUrl = await getSearchUrl();
    const result = await chrome.storage.local.get(['search.name', 'search.keyword']);
    
    const searchEngineName = result['search.name'] || DEFAULT_SEARCH_ENGINE.name;
    const searchKeyword = result['search.keyword'] || DEFAULT_SEARCH_ENGINE.keyword;
    
    // Check if search engine already exists
    const engines = await chrome.search.get();
    const existingEngine = engines.find(e => e.name === searchEngineName);
    
    if (existingEngine) {
      // Remove existing engine first (Chrome doesn't support updating)
      try {
        await chrome.search.remove({ name: searchEngineName });
      } catch (e) {
        console.warn('DIG Extension: Could not remove existing search engine:', e);
      }
    }
    
    // Add the new search engine
    await chrome.search.add({
      name: searchEngineName,
      keyword: searchKeyword,
      faviconUrl: DEFAULT_SEARCH_ENGINE.faviconUrl,
      searchUrl: searchUrl
    });
    
    console.log('DIG Extension: Custom search engine added:', searchEngineName);
    return { success: true, name: searchEngineName };
  } catch (error) {
    console.error('DIG Extension: Failed to add custom search engine:', error);
    return { success: false, error: error.message };
  }
}

// Get current default search engine
async function getDefaultSearchEngine() {
  try {
    // Check if chrome.search API is available
    if (!chrome.search || typeof chrome.search.get !== 'function') {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }
    
    const engines = await chrome.search.get();
    const defaultEngine = engines.find(e => e.isDefault);
    return { success: true, engine: defaultEngine };
  } catch (error) {
    console.error('DIG Extension: Failed to get default search engine:', error);
    return { success: false, error: error.message };
  }
}

// Check if DIG search engine is set as default
async function isDigSearchDefault() {
  try {
    // Check if chrome.search API is available
    if (!chrome.search || typeof chrome.search.get !== 'function') {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }
    
    const result = await chrome.storage.local.get(['search.name']);
    const searchEngineName = result['search.name'] || DEFAULT_SEARCH_ENGINE.name;
    const engines = await chrome.search.get();
    const defaultEngine = engines.find(e => e.isDefault);
    
    return {
      success: true,
      isDefault: defaultEngine && defaultEngine.name === searchEngineName,
      defaultEngine: defaultEngine ? defaultEngine.name : null
    };
  } catch (error) {
    console.error('DIG Extension: Failed to check if DIG search is default:', error);
    return { success: false, error: error.message };
  }
}

// Handle search engine management messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'addSearchEngine') {
    (async () => {
      const result = await addCustomSearchEngine();
      sendResponse(result);
    })();
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'getDefaultSearchEngine') {
    (async () => {
      const result = await getDefaultSearchEngine();
      sendResponse(result);
    })();
    return true;
  }
  
  if (message.action === 'isDigSearchDefault') {
    (async () => {
      const result = await isDigSearchDefault();
      sendResponse(result);
    })();
    return true;
  }
  
  if (message.action === 'updateSearchConfig') {
    // Save search configuration
    const storageData = {};
    if (message.name) storageData['search.name'] = message.name;
    if (message.keyword) storageData['search.keyword'] = message.keyword;
    if (message.url) storageData['search.url'] = message.url;
    if (message.enabled !== undefined) storageData['search.enabled'] = message.enabled;
    
    chrome.storage.local.set(storageData).then(async () => {
      // Re-add search engine with new config
      const result = await addCustomSearchEngine();
      sendResponse(result);
    });
    return true;
  }
  
  return false;
});

// Add search engine on extension install/startup
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['search.enabled']);
  if (result['search.enabled'] !== false) {
    // Default to enabled, add search engine
    await addCustomSearchEngine();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const result = await chrome.storage.local.get(['search.enabled']);
  if (result['search.enabled'] !== false) {
    await addCustomSearchEngine();
  }
});

