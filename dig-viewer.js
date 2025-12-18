// DIG Viewer script - requests navigation to dig.local subdomain URL
// Wait for DOM to be ready
(function() {
  'use strict';
  
  // Wait for DOM to load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  function init() {
    // Get the URN from URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const urn = urlParams.get('urn');

    console.log('DIG Viewer: URN:', urn);

    const loading = document.getElementById('loading');

    async function loadContent() {
      try {
        loading.textContent = 'Loading content...';
        
        // Request background script to navigate to server URL
        if (urn) {
          // Construct dig:// URL from URN
          const digUrl = urn.startsWith('dig://') ? urn : `dig://${urn}`;
          
          console.log('DIG Viewer: Requesting background script to navigate to:', digUrl);
          
          // Request background script to convert dig:// URL to server URL and navigate
          // The background script will convert to subdomain format (e.g., <encodedStoreId>.dig.local/path)
          chrome.runtime.sendMessage({
            action: 'navigateToDigUrl',
            url: digUrl
          }, (response) => {
            // This callback may not execute if navigation happens quickly
            if (chrome.runtime.lastError) {
              const errorMsg = chrome.runtime.lastError.message;
              if (errorMsg && errorMsg.includes('message port closed')) {
                // This is expected - navigation closed the port
                console.log('DIG Viewer: Navigation initiated (port closed as expected)');
              } else {
                // Real error
                console.error('DIG Viewer: Error requesting navigation:', chrome.runtime.lastError);
                loading.textContent = 'Error: ' + chrome.runtime.lastError.message;
                loading.style.color = '#f00';
              }
            } else if (response && response.error) {
              console.error('DIG Viewer: Error:', response.error);
              loading.textContent = 'Error: ' + response.error;
              loading.style.color = '#f00';
            } else {
              console.log('DIG Viewer: Request sent successfully');
            }
          });
          
          // Show loading message - navigation will happen from background script
          loading.textContent = 'Navigating to content...';
          return; // Don't continue with the rest of the function
        }
        
        // If no URN provided, show error
        throw new Error('No URN provided');
      } catch (e) {
        console.error('DIG Viewer: Error loading content:', e);
        loading.textContent = 'Error: ' + e.message;
        loading.style.color = '#f00';
      }
    }

    // Start loading
    if (urn) {
      loadContent();
    } else {
      loading.textContent = 'No URN provided';
      loading.style.color = '#f00';
    }
  }
})();

