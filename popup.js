// Popup controller — the product surface (NOT a developer control panel).
//
// The popup keeps only product-level controls: the verified-status line + wallet panel
// (in popup-wallet.js), an "open a chia:// address" box, an on/off toggle for chia://
// resolution, the ecosystem funnels, and a link to DIG settings (the options page). All
// developer/config controls — the dig-node host, the upstream RPC endpoint, the local
// cache — live on the options page (the one settings home), reached via "DIG settings".

// Ecosystem funnel destinations. Kept in sync with links.mjs (the shared source of
// truth); popup.js is loaded as a classic script and cannot `import`, so the values are
// mirrored here and pinned by tests/links.test.mjs against links.mjs.
const ECOSYSTEM_LINKS = {
  HUB_URL: 'https://hub.dig.net',
  DIG_NETWORK_URL: 'https://dig.net',
  DOCS_URL: 'https://docs.dig.net',
  TIBETSWAP_URL: 'https://v2.tibetswap.io/',
  DIG_BROWSER_URL: 'https://github.com/DIG-Network/DIG_Browser/releases',
};

// Ordered Resources/footer links (mirrors RESOURCE_LINKS in links.mjs — pinned by
// tests/links.test.mjs so the labels/urls can never drift between the two surfaces).
const RESOURCE_LINKS = [
  { id: 'get-dig', label: 'Get $DIG', url: ECOSYSTEM_LINKS.TIBETSWAP_URL },
  { id: 'visit-dig-network', label: 'Visit DIG Network', url: ECOSYSTEM_LINKS.DIG_NETWORK_URL },
  { id: 'learn-the-protocol', label: 'Learn the protocol', url: ECOSYSTEM_LINKS.DOCS_URL },
];

// Open an ecosystem link in a new tab and close the popup.
function openEcosystemLink(url) {
  chrome.tabs.create({ url });
  window.close();
}

// Wire the ecosystem funnel surfaces: Browse DIGHUb CTA, header dig.net link,
// the Resources links, and the soft full-DIG-Browser upsell.
function setupEcosystemFunnels() {
  const browseHubButton = document.getElementById('browseHubButton');
  if (browseHubButton) {
    browseHubButton.addEventListener('click', () => openEcosystemLink(ECOSYSTEM_LINKS.HUB_URL));
  }

  const visitDigNetworkLink = document.getElementById('visitDigNetworkLink');
  if (visitDigNetworkLink) {
    visitDigNetworkLink.addEventListener('click', (e) => {
      e.preventDefault();
      openEcosystemLink(ECOSYSTEM_LINKS.DIG_NETWORK_URL);
    });
  }

  const resourcesLinks = document.getElementById('resourcesLinks');
  if (resourcesLinks) {
    RESOURCE_LINKS.forEach(({ id, label, url }) => {
      const link = document.createElement('a');
      link.id = `resource-${id}`;
      link.className = 'resource-link';
      link.href = url;
      link.textContent = label;
      link.title = label;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        openEcosystemLink(url);
      });
      resourcesLinks.appendChild(link);
    });
  }

  const getFullBrowserLink = document.getElementById('getFullBrowserLink');
  if (getFullBrowserLink) {
    getFullBrowserLink.addEventListener('click', (e) => {
      e.preventDefault();
      openEcosystemLink(ECOSYSTEM_LINKS.DIG_BROWSER_URL);
    });
  }
}

// Initialize popup - handle both DOMContentLoaded and immediate execution
async function initPopup() {
  const toggle = document.getElementById('extensionToggle');
  const statusText = document.getElementById('statusText');
  const digUrlInput = document.getElementById('digUrlInput');
  const goButton = document.getElementById('goButton');

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

  // Handle toggle change
  toggle.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await chrome.storage.local.set({ extensionEnabled: enabled });
    updateStatusText(enabled);

    // Notify background script
    chrome.runtime.sendMessage({ action: 'toggleExtension', enabled });
  });

  // Open a chia:// address in the current tab. The background SW intercepts chia://
  // navigations, fetches + verifies the content, and renders it in the viewer.
  function navigateToDigUrl() {
    if (!digUrlInput) return;

    const url = digUrlInput.value.trim();
    if (!url) return;

    // If it doesn't start with chia://, add it.
    const digUrl = url.startsWith('chia://') ? url : `chia://${url}`;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.update(tabs[0].id, { url: digUrl });
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

  // Wire the ecosystem funnel surfaces (Browse DIGHUb, Resources, upsell, dig.net).
  setupEcosystemFunnels();

  if (goButton) {
    goButton.addEventListener('click', navigateToDigUrl);
  }

  if (digUrlInput) {
    digUrlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        navigateToDigUrl();
      }
    });

    // Focus the input when the popup opens.
    try {
      digUrlInput.focus();
    } catch (e) {
      // Focus might fail in some contexts, ignore.
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
