// Default server configuration
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

// Format server host for display
function formatServerHost(url, port) {
  return `${url}:${port}`;
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
    url: result['server.url'] || 'localhost',
    port: result['server.port'] || 8080
  };
}

// Convert dig:// URL to configured server URL
async function convertDigUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('dig://')) {
    return url;
  }
  
  const config = await getServerConfig();
  const urlPath = url.replace(/^dig:\/\//, '');
  let serverUrl = config.url;
  
  // Handle different server URL formats
  if (!serverUrl.includes('://')) {
    serverUrl = `http://${serverUrl}`;
  }
  
  // Remove trailing slash
  serverUrl = serverUrl.replace(/\/$/, '');
  
  return `${serverUrl}:${config.port}/${urlPath}`;
}

// Initialize popup - handle both DOMContentLoaded and immediate execution
async function initPopup() {
  const toggle = document.getElementById('extensionToggle');
  const statusText = document.getElementById('statusText');
  const digUrlInput = document.getElementById('digUrlInput');
  const goButton = document.getElementById('goButton');
  const serverHostInput = document.getElementById('serverHostInput');
  const restoreDefaultButton = document.getElementById('restoreDefaultButton');
  const serverInfoText = document.getElementById('serverInfoText');
  
  // Check if all required elements exist
  if (!toggle || !statusText) {
    console.error('DIG Extension: Required elements not found in popup');
    return;
  }
  
  // Load saved state (default to enabled)
  const result = await chrome.storage.local.get(['extensionEnabled']);
  const isEnabled = result.extensionEnabled !== false; // Default to true
  
  toggle.checked = isEnabled;
  updateStatusText(isEnabled);
  
  // Load server configuration
  await loadServerConfig();
  
  // Handle toggle change
  toggle.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await chrome.storage.local.set({ extensionEnabled: enabled });
    updateStatusText(enabled);
    
    // Notify background script
    chrome.runtime.sendMessage({ action: 'toggleExtension', enabled });
  });
  
  // Handle server host change - save immediately on input
  if (serverHostInput) {
    let saveTimeout = null;
    
    // Save on input change (debounced for immediate effect)
    serverHostInput.addEventListener('input', async () => {
      // Clear previous timeout
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      
      // Save immediately after a short delay to avoid too many saves while typing
      saveTimeout = setTimeout(async () => {
        await saveServerConfig();
      }, 300);
    });
    
    // Also save on blur and Enter
    serverHostInput.addEventListener('blur', async () => {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      await saveServerConfig();
    });
    
    serverHostInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        if (saveTimeout) {
          clearTimeout(saveTimeout);
        }
        await saveServerConfig();
        serverHostInput.blur(); // Remove focus
      }
    });
  }
  
  // Handle restore default button
  if (restoreDefaultButton) {
    restoreDefaultButton.addEventListener('click', async () => {
      await restoreDefaultServerConfig();
    });
  }
  
  // Handle URL input - navigate on Enter or button click
  async function navigateToDigUrl() {
    if (!digUrlInput) return;
    
    const url = digUrlInput.value.trim();
    if (!url) return;
    
    // If it doesn't start with dig://, add it
    const digUrl = url.startsWith('dig://') ? url : `dig://${url}`;
    
    // Convert to configured server URL
    const serverUrl = await convertDigUrl(digUrl);
    
    // Get the current active tab and navigate it
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.update(tabs[0].id, { url: serverUrl });
        // Close popup after navigation
        window.close();
      }
    });
  }
  
  function updateStatusText(enabled) {
    if (!statusText) return;
    
    if (enabled) {
      statusText.textContent = 'Active';
      statusText.classList.add('active');
    } else {
      statusText.textContent = 'Inactive';
      statusText.classList.remove('active');
    }
  }
  
  async function loadServerConfig() {
    const config = await getServerConfig();
    if (serverHostInput) {
      serverHostInput.value = formatServerHost(config.url, config.port);
    }
    await updateServerInfoText();
  }
  
  async function saveServerConfig() {
    const host = serverHostInput ? serverHostInput.value.trim() : DEFAULT_SERVER_HOST;
    const config = parseServerHost(host);
    
    // Save in new format
    await chrome.storage.local.set({
      'server.host': formatServerHost(config.url, config.port),
      // Also save in old format for backward compatibility
      'server.url': config.url,
      'server.port': config.port
    });
    
    // Notify background script immediately
    chrome.runtime.sendMessage({ 
      action: 'updateServerConfig', 
      host: formatServerHost(config.url, config.port),
      url: config.url,
      port: config.port
    });
    
    await updateServerInfoText();
  }
  
  async function restoreDefaultServerConfig() {
    if (serverHostInput) {
      serverHostInput.value = DEFAULT_SERVER_HOST;
    }
    await saveServerConfig();
  }
  
  async function updateServerInfoText() {
    if (!serverInfoText) return;
    const config = await getServerConfig();
    let serverUrl = config.url;
    if (!serverUrl.includes('://')) {
      serverUrl = `http://${serverUrl}`;
    }
    serverUrl = serverUrl.replace(/\/$/, '');
    serverInfoText.textContent = `Redirects to: ${serverUrl}:${config.port}`;
  }
  
  // Only add event listeners if elements exist
  if (goButton) {
    goButton.addEventListener('click', navigateToDigUrl);
  }
  
  if (digUrlInput) {
    digUrlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        navigateToDigUrl();
      }
    });
    
    // Focus the input when popup opens
    try {
      digUrlInput.focus();
    } catch (e) {
      // Focus might fail in some contexts, ignore
    }
  }
}

// Try DOMContentLoaded first, but also check if DOM is already ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  // DOM is already loaded, run immediately
  initPopup();
}
