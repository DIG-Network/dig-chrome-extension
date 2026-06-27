// DIG Viewer script - fetches content via RPC and embeds it
// Wait for DOM to be ready
(function() {
  'use strict';

  // Show the verified / verification-failed banner (mirrors the native DIG Browser's
  // verified badge). `verified === true` → green "verified on Chia"; false → red warning.
  function showVerifyBanner(verified) {
    const banner = document.getElementById('verifyBanner');
    const text = document.getElementById('verifyText');
    const close = document.getElementById('verifyClose');
    if (!banner || !text) return;
    if (verified) {
      banner.className = 'verified';
      text.textContent = 'Verified — Merkle-proven against the on-chain root, decrypted on this device';
    } else {
      banner.className = 'failed';
      text.textContent = 'Verification failed — this content could not be proven against the on-chain root. Do not trust it.';
    }
    document.body.classList.add('has-banner');
    if (close) {
      close.onclick = () => {
        banner.style.display = 'none';
        document.body.classList.remove('has-banner');
      };
    }
  }

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
        if (!urn) {
          throw new Error('No URN provided');
        }
        
        loading.textContent = 'Loading content via RPC...';
        
        // Construct chia:// URL from URN
        const digUrl = urn.startsWith('chia://') ? urn : `chia://${urn}`;
        
        console.log('DIG Viewer: Requesting content via RPC for:', digUrl);
        
        // Request background script to fetch content via RPC
        chrome.runtime.sendMessage({
          action: 'proxyRequest',
          url: digUrl
        }, async (response) => {
          if (chrome.runtime.lastError) {
            console.error('DIG Viewer: Error requesting content:', chrome.runtime.lastError);
            loading.textContent = 'Error: ' + chrome.runtime.lastError.message;
            loading.style.color = '#f00';
            return;
          }
          
          if (response && response.error) {
            console.error('DIG Viewer: RPC error:', response.error);
            loading.textContent = 'Error: ' + response.error;
            loading.style.color = '#f00';
            return;
          }
          
          if (!response || !response.success || !response.data) {
            console.error('DIG Viewer: Invalid response:', response);
            loading.textContent = 'Error: Invalid response from RPC';
            loading.style.color = '#f00';
            return;
          }
          
          // response.data is a data URL from RPC
          const dataUrl = response.data;
          const contentType = response.contentType || 'text/html';
          const verified = !!response.verified;

          console.log('DIG Viewer: Received data URL, contentType:', contentType, 'verified:', verified);

          // Report verification to the background SW (sets the toolbar "Verified" badge)
          // and show the in-page verified/failed banner — mirrors the native DIG Browser.
          try {
            chrome.runtime.sendMessage(
              { action: 'reportVerification', verified, urn },
              () => { void chrome.runtime.lastError; }
            );
          } catch (e) { /* non-fatal */ }
          showVerifyBanner(verified);

          // Hide loading indicator
          loading.style.display = 'none';
          
          // Create iframe to display the content
          const iframe = document.createElement('iframe');
          iframe.src = dataUrl;
          iframe.style.width = '100%';
          iframe.style.height = '100vh';
          iframe.style.border = 'none';
          
          // Handle iframe load
          iframe.onload = () => {
            console.log('DIG Viewer: Content loaded in iframe');
          };
          
          iframe.onerror = (error) => {
            console.error('DIG Viewer: Error loading iframe:', error);
            loading.style.display = 'block';
            loading.textContent = 'Error loading content';
            loading.style.color = '#f00';
          };
          
          // Replace body content with iframe
          document.body.innerHTML = '';
          document.body.appendChild(iframe);
        });
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

