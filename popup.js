// Default server configuration
const DEFAULT_SERVER_HOST = 'localhost:80';

// Default DIG RPC endpoint (real rpc.dig.net)
const DEFAULT_DIG_RPC_ENDPOINT = 'https://rpc.dig.net/';

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
      port: result['server.port'] || 80
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
  const digRpcEndpointInput = document.getElementById('digRpcEndpointInput');
  const restoreRpcDefaultButton = document.getElementById('restoreRpcDefaultButton');
  const digRpcEndpointInfoText = document.getElementById('digRpcEndpointInfoText');
  
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

  // Load DIG RPC endpoint configuration
  await loadDigRpcEndpointConfig();
  
  // Check dig.local resolvability
  await checkDigLocalResolvability();
  
  // Setup retry button
  setupRetryButton();
  
  // Load search engine configuration (will be called after initPopup completes)
  
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

  // Handle DIG RPC endpoint input changes
  if (digRpcEndpointInput) {
    let rpcSaveTimeout = null;
    digRpcEndpointInput.addEventListener('input', () => {
      if (rpcSaveTimeout) clearTimeout(rpcSaveTimeout);
      rpcSaveTimeout = setTimeout(() => saveDigRpcEndpointConfig(), 300);
    });
    digRpcEndpointInput.addEventListener('blur', () => {
      if (rpcSaveTimeout) clearTimeout(rpcSaveTimeout);
      saveDigRpcEndpointConfig();
    });
    digRpcEndpointInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        if (rpcSaveTimeout) clearTimeout(rpcSaveTimeout);
        saveDigRpcEndpointConfig();
        digRpcEndpointInput.blur();
      }
    });
  }

  // Handle restore RPC default button
  if (restoreRpcDefaultButton) {
    restoreRpcDefaultButton.addEventListener('click', async () => {
      if (digRpcEndpointInput) digRpcEndpointInput.value = DEFAULT_DIG_RPC_ENDPOINT;
      await saveDigRpcEndpointConfig();
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

  async function loadDigRpcEndpointConfig() {
    if (!digRpcEndpointInput) return;
    const { digRpcEndpoint } = await chrome.storage.local.get('digRpcEndpoint');
    const endpoint = digRpcEndpoint || DEFAULT_DIG_RPC_ENDPOINT;
    digRpcEndpointInput.value = endpoint;
    if (digRpcEndpointInfoText) {
      digRpcEndpointInfoText.textContent = `Content fetched from: ${endpoint}`;
    }
  }

  async function saveDigRpcEndpointConfig() {
    if (!digRpcEndpointInput) return;
    const raw = digRpcEndpointInput.value.trim();
    // Ensure trailing slash for consistency
    const endpoint = raw ? (raw.endsWith('/') ? raw : raw + '/') : DEFAULT_DIG_RPC_ENDPOINT;
    await chrome.storage.local.set({ digRpcEndpoint: endpoint });
    if (digRpcEndpointInfoText) {
      digRpcEndpointInfoText.textContent = `Content fetched from: ${endpoint}`;
    }
  }
  
  // Check if dig.local is resolvable
  async function checkDigLocalResolvability(showLoading = true) {
    const statusIndicator = document.getElementById('statusIndicator');
    const digLocalStatusText = document.getElementById('digLocalStatusText');
    const digLocalInfo = document.getElementById('digLocalInfo');
    const digLocalMessage = document.getElementById('digLocalMessage');
    const hostsSetup = document.getElementById('hostsSetup');
    const retryButton = document.getElementById('retryButton');
    
    if (!statusIndicator || !digLocalStatusText) return;
    
    // Show loading state
    if (showLoading) {
      statusIndicator.textContent = '●';
      statusIndicator.className = 'status-indicator checking';
      digLocalStatusText.textContent = 'Checking...';
      if (retryButton) retryButton.style.display = 'none';
    }
    
    // Use background script to check DNS resolution (more reliable)
    // Add timeout to prevent infinite waiting (reduced to 3 seconds)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('DNS check timeout')), 3000);
    });
    
    try {
      console.log('DIG Popup: Sending checkDigLocalDNS message...');
      const response = await Promise.race([
        chrome.runtime.sendMessage({ 
          action: 'checkDigLocalDNS' 
        }),
        timeoutPromise
      ]);
      
      console.log('DIG Popup: Received DNS check response:', response);
      
      // Handle case where response is undefined or null
      if (response === undefined || response === null) {
        console.warn('DIG Popup: Response is undefined, using fallback');
        throw new Error('No response received');
      }
      
      if (response && response.resolvable === true) {
        statusIndicator.textContent = '●';
        statusIndicator.className = 'status-indicator resolved';
        digLocalStatusText.textContent = 'Resolvable';
        digLocalInfo.style.display = 'none';
        if (retryButton) retryButton.style.display = 'none';
      } else {
        statusIndicator.textContent = '●';
        statusIndicator.className = 'status-indicator not-resolved';
        digLocalStatusText.textContent = 'Not Resolvable';
        digLocalInfo.style.display = 'block';
        digLocalMessage.textContent = 'dig.local is not configured in your hosts file. Follow the instructions below to set it up.';
        hostsSetup.style.display = 'block';
        if (retryButton) retryButton.style.display = 'flex';
      }
    } catch (error) {
      console.error('DIG Popup: Error checking DNS:', error);
      
      // Check if it's a timeout
      if (error.message && error.message.includes('timeout')) {
        console.log('DIG Popup: DNS check timed out, trying fallback');
      }
      
      // Fallback: try direct fetch check
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        
        await fetch('http://dig.local/', { 
          method: 'GET',
          signal: controller.signal,
          mode: 'no-cors'
        });
        clearTimeout(timeoutId);
        
        // If we get here, DNS resolved
        statusIndicator.textContent = '●';
        statusIndicator.className = 'status-indicator resolved';
        digLocalStatusText.textContent = 'Resolvable';
        digLocalInfo.style.display = 'none';
        if (retryButton) retryButton.style.display = 'none';
      } catch (fetchError) {
        console.error('DIG Popup: Fallback DNS check failed:', fetchError);
        
        // Check if we're currently on dig.local (last resort check)
        try {
          const currentUrl = window.location.href;
          if (currentUrl.includes('dig.local')) {
            // We're on dig.local, so it's definitely resolvable
            statusIndicator.textContent = '●';
            statusIndicator.className = 'status-indicator resolved';
            digLocalStatusText.textContent = 'Resolvable';
            digLocalInfo.style.display = 'none';
            if (retryButton) retryButton.style.display = 'none';
            return;
          }
        } catch (e) {
          // Ignore
        }
        
        // DNS doesn't resolve
        statusIndicator.textContent = '●';
        statusIndicator.className = 'status-indicator not-resolved';
        digLocalStatusText.textContent = 'Not Resolvable';
        digLocalInfo.style.display = 'block';
        digLocalMessage.textContent = 'dig.local is not configured in your hosts file. Follow the instructions below to set it up.';
        hostsSetup.style.display = 'block';
        if (retryButton) retryButton.style.display = 'flex';
      }
    }
    
    // Setup OS-specific instructions
    setupOSInstructions();
  }
  
  // Setup retry button handler
  function setupRetryButton() {
    const retryButton = document.getElementById('retryButton');
    if (retryButton) {
      retryButton.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await checkDigLocalResolvability(true);
      });
    }
  }
  
  // Setup OS-specific instructions
  function setupOSInstructions() {
    const showInstructionsButton = document.getElementById('showInstructionsButton');
    const instructions = document.getElementById('instructions');
    const osTabs = document.querySelectorAll('.os-tab');
    const osInstructions = document.querySelectorAll('.os-instructions');
    
    if (!showInstructionsButton || !instructions) return;
    
    // Detect OS
    const platform = navigator.platform.toLowerCase();
    let detectedOS = 'windows';
    if (platform.includes('mac')) {
      detectedOS = 'macos';
    } else if (platform.includes('linux') || platform.includes('x11')) {
      detectedOS = 'linux';
    }
    
    // Show instructions button click handler
    showInstructionsButton.addEventListener('click', () => {
      instructions.style.display = instructions.style.display === 'none' ? 'block' : 'none';
      showInstructionsButton.textContent = instructions.style.display === 'none' ? 'Show Setup Instructions' : 'Hide Instructions';
      
      // Show detected OS instructions by default
      if (instructions.style.display === 'block') {
        showOSInstructions(detectedOS);
      }
    });
    
    // OS tab click handlers
    osTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const os = tab.getAttribute('data-os');
        showOSInstructions(os);
        
        // Update active tab
        osTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      });
    });
  }
  
  function showOSInstructions(os) {
    const osInstructions = document.querySelectorAll('.os-instructions');
    osInstructions.forEach(inst => {
      inst.style.display = 'none';
    });
    
    const targetInst = document.getElementById(`${os}Instructions`);
    if (targetInst) {
      targetInst.style.display = 'block';
    }
  }
  
  // ============================================================================
  // Search Engine Management
  // ============================================================================
  
  const searchEngineToggle = document.getElementById('searchEngineToggle');
  const searchEngineConfig = document.getElementById('searchEngineConfig');
  const searchUrlInput = document.getElementById('searchUrlInput');
  const searchEngineInfoText = document.getElementById('searchEngineInfoText');
  const searchEngineStatus = document.getElementById('searchEngineStatus');
  const searchEngineStatusText = document.getElementById('searchEngineStatusText');
  const showSearchInstructionsButton = document.getElementById('showSearchInstructionsButton');
  const searchInstructions = document.getElementById('searchInstructions');
  const searchEngineNameDisplay = document.getElementById('searchEngineNameDisplay');
  
  // Load search engine configuration
  async function loadSearchEngineConfig() {
    const result = await chrome.storage.local.get(['search.enabled', 'search.url', 'search.name']);
    const isEnabled = result['search.enabled'] !== false; // Default to enabled
    const searchUrl = result['search.url'] || 'http://dig.local?urn=%s';
    const searchName = result['search.name'] || 'DIG Network Search';
    
    if (searchEngineToggle) {
      searchEngineToggle.checked = isEnabled;
    }
    
    if (searchUrlInput) {
      searchUrlInput.value = searchUrl;
    }
    
    if (searchEngineNameDisplay) {
      searchEngineNameDisplay.textContent = searchName;
    }
    
    updateSearchEngineConfigVisibility(isEnabled);
    
    if (isEnabled) {
      await checkSearchEngineStatus();
    }
  }
  
  // Update search engine configuration visibility
  function updateSearchEngineConfigVisibility(enabled) {
    if (searchEngineConfig) {
      searchEngineConfig.style.display = enabled ? 'block' : 'none';
    }
  }
  
  // Save search engine configuration
  async function saveSearchEngineConfig() {
    const isEnabled = searchEngineToggle ? searchEngineToggle.checked : false;
    const searchUrl = searchUrlInput ? searchUrlInput.value.trim() : 'https://www.google.com/search?q=%s';
    
    // Validate search URL contains %s
    if (!searchUrl.includes('%s')) {
      if (searchEngineInfoText) {
        searchEngineInfoText.textContent = 'Warning: Search URL should contain %s for the query';
        searchEngineInfoText.style.color = '#ff6b6b';
      }
      return;
    }
    
    // Save configuration
    await chrome.storage.local.set({
      'search.enabled': isEnabled,
      'search.url': searchUrl
    });
    
    // Add or remove search engine
    if (isEnabled) {
      const response = await chrome.runtime.sendMessage({
        action: 'updateSearchConfig',
        url: searchUrl,
        enabled: true
      });
      
      if (response && response.success) {
        if (searchEngineInfoText) {
          searchEngineInfoText.textContent = 'Search engine added successfully';
          searchEngineInfoText.style.color = '#51cf66';
        }
        await checkSearchEngineStatus();
      } else {
        if (searchEngineInfoText) {
          searchEngineInfoText.textContent = 'Failed to add search engine: ' + (response?.error || 'Unknown error');
          searchEngineInfoText.style.color = '#ff6b6b';
        }
      }
    } else {
      // Search engine disabled - Chrome will keep it but we won't update it
      if (searchEngineInfoText) {
        searchEngineInfoText.textContent = 'Search engine disabled';
        searchEngineInfoText.style.color = '#868e96';
      }
      if (searchEngineStatus) {
        searchEngineStatus.style.display = 'none';
      }
    }
  }
  
  // Check if DIG search engine is set as default
  async function checkSearchEngineStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'isDigSearchDefault' });
      
      if (response && response.success) {
        if (searchEngineStatus) {
          searchEngineStatus.style.display = 'block';
        }
        
        if (response.isDefault) {
          if (searchEngineStatusText) {
            searchEngineStatusText.textContent = '✓ Set as default search engine';
            searchEngineStatusText.style.color = '#51cf66';
          }
          if (showSearchInstructionsButton) {
            showSearchInstructionsButton.style.display = 'none';
          }
        } else {
          if (searchEngineStatusText) {
            searchEngineStatusText.textContent = `Not set as default (current: ${response.defaultEngine || 'Unknown'})`;
            searchEngineStatusText.style.color = '#ffd43b';
          }
          if (showSearchInstructionsButton) {
            showSearchInstructionsButton.style.display = 'block';
          }
        }
      }
    } catch (error) {
      console.error('DIG Extension: Failed to check search engine status:', error);
    }
  }
  
  // Setup search engine event listeners
  if (searchEngineToggle) {
    searchEngineToggle.addEventListener('change', async () => {
      updateSearchEngineConfigVisibility(searchEngineToggle.checked);
      await saveSearchEngineConfig();
    });
  }
  
  if (searchUrlInput) {
    let saveTimeout = null;
    
    searchUrlInput.addEventListener('input', async () => {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      
      saveTimeout = setTimeout(async () => {
        if (searchEngineToggle && searchEngineToggle.checked) {
          await saveSearchEngineConfig();
        }
      }, 500);
    });
    
    searchUrlInput.addEventListener('blur', async () => {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      if (searchEngineToggle && searchEngineToggle.checked) {
        await saveSearchEngineConfig();
      }
    });
    
    searchUrlInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        if (saveTimeout) {
          clearTimeout(saveTimeout);
        }
        if (searchEngineToggle && searchEngineToggle.checked) {
          await saveSearchEngineConfig();
        }
        searchUrlInput.blur();
      }
    });
  }
  
  if (showSearchInstructionsButton) {
    showSearchInstructionsButton.addEventListener('click', () => {
      if (searchInstructions) {
        searchInstructions.style.display = searchInstructions.style.display === 'none' ? 'block' : 'none';
        showSearchInstructionsButton.textContent = searchInstructions.style.display === 'none' ? 'How to Set as Default' : 'Hide Instructions';
      }
    });
  }
  
  // Load search engine config on popup init
  await loadSearchEngineConfig();
  
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
