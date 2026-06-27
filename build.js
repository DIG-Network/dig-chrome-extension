/**
 * Build script for DIG Network Browser Extension
 * Prepares the extension for installation by validating and copying files
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_FILES = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'popup.js',
  // Popup wallet panel + verified line + per-origin consent (module).
  'popup-wallet.js',
  'dig-urn.mjs',
  // Ecosystem funnel: shared link constants + first-run welcome page.
  'links.mjs',
  'welcome.html',
  'welcome.js',
  // DIG Home (new-tab override) — ported from the native DIG Browser NTP.
  'newtab.html',
  'newtab.css',
  'newtab.js',
  // DIG settings (options page): cache + companion + RPC + wallet project id.
  'options.html',
  'options.css',
  'options.js',
  // Shared app directory + omnibox classifier (NTP) and wallet method/broker modules.
  'apps.mjs',
  'wallet-methods.mjs',
  'wallet-broker.mjs',
  // WalletConnect → Sage transport (runs in the popup page).
  'wallet-wc.js',
  'background.js',
  'middleware.js',
  'content.js',
  'page-script.js',
  // Injected window.chia CHIP-0002 provider (main world).
  'dig-provider.js',
  'dig-viewer.html',
  'dig-viewer.js',
  // dig-client WASM (ES module + binary) — required for client-side decryption in the module SW
  'dig_client.js',
  'dig_client_bg.wasm',
];

const OPTIONAL_FILES = [
  'test.html' // Test page for development
];

const ICON_SIZES = [16, 48, 128];
const DIST_DIR = path.join(__dirname, 'dist');
const ICONS_DIR = path.join(__dirname, 'icons');
const SRC_DIR = path.join(__dirname, 'src');
const FAVICON_PATH = path.join(SRC_DIR, 'favicon.png');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function checkFile(filePath, required = true) {
  const exists = fs.existsSync(filePath);
  if (!exists && required) {
    log(`❌ Missing required file: ${filePath}`, 'red');
    return false;
  } else if (!exists) {
    log(`⚠️  Optional file missing: ${filePath}`, 'yellow');
  } else {
    log(`✓ Found: ${filePath}`, 'green');
  }
  return exists;
}

function validateExtension() {
  log('\n🔍 Validating extension files...', 'blue');
  
  let allValid = true;
  
  // Check required files
  EXTENSION_FILES.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (!checkFile(filePath, true)) {
      allValid = false;
    }
  });
  
  // Check favicon (required for extension icon)
  log('\n📦 Checking extension icon...', 'blue');
  const faviconExists = checkFile(FAVICON_PATH, false);
  
  if (!faviconExists) {
    log('\n⚠️  Extension icon (src/favicon.png) is missing.', 'yellow');
    log('   Note: Extension will work without icon, but Chrome will use a default icon.', 'yellow');
  }
  
  return allValid; // Icons are optional, don't fail build if missing
}

function createDistDirectory() {
  log('\n📁 Creating dist directory...', 'blue');
  
  if (fs.existsSync(DIST_DIR)) {
    log('Cleaning existing dist directory...', 'yellow');
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  
  fs.mkdirSync(DIST_DIR, { recursive: true });
  
  log('✓ Dist directory created', 'green');
}

// Create a minimal valid PNG icon (placeholder)
// Uses a minimal 1x1 transparent PNG that Chrome will accept and scale
function createPlaceholderIcon(size) {
  // Minimal valid PNG: 1x1 transparent pixel
  // Chrome will scale this to the required size
  // Base64 encoded minimal PNG
  const base64PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return Buffer.from(base64PNG, 'base64');
}

function copyFiles() {
  log('\n📋 Copying extension files...', 'blue');
  
  // Copy main extension files
  EXTENSION_FILES.forEach(file => {
    const src = path.join(__dirname, file);
    const dest = path.join(DIST_DIR, file);
    
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      log(`✓ Copied: ${file}`, 'green');
    }
  });
  
  // Copy optional files (like test.html)
  OPTIONAL_FILES.forEach(file => {
    const src = path.join(__dirname, file);
    const dest = path.join(DIST_DIR, file);
    
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      log(`✓ Copied: ${file} (optional)`, 'green');
    }
  });
  
  // Copy src directory (contains favicon.png and logo.png)
  const srcDir = path.join(__dirname, 'src');
  const distSrcDir = path.join(DIST_DIR, 'src');
  
  if (fs.existsSync(srcDir)) {
    // Create src directory in dist
    fs.mkdirSync(distSrcDir, { recursive: true });
    
    // Copy favicon.png (extension icon)
    const faviconSrc = path.join(srcDir, 'favicon.png');
    const faviconDest = path.join(distSrcDir, 'favicon.png');
    if (fs.existsSync(faviconSrc)) {
      fs.copyFileSync(faviconSrc, faviconDest);
      log(`✓ Copied: src/favicon.png (extension icon)`, 'green');
    } else {
      log(`⚠️  Favicon not found: ${faviconSrc}`, 'yellow');
    }
    
    // Copy logo.png
    const logoSrc = path.join(srcDir, 'logo.png');
    const logoDest = path.join(distSrcDir, 'logo.png');
    if (fs.existsSync(logoSrc)) {
      fs.copyFileSync(logoSrc, logoDest);
      log(`✓ Copied: src/logo.png`, 'green');
    } else {
      log(`⚠️  Logo not found: ${logoSrc}`, 'yellow');
    }

    // Copy the vector wordmark used by the popup header lockup.
    const wordmarkSrc = path.join(srcDir, 'Wordmark-Black.svg');
    const wordmarkDest = path.join(distSrcDir, 'Wordmark-Black.svg');
    if (fs.existsSync(wordmarkSrc)) {
      fs.copyFileSync(wordmarkSrc, wordmarkDest);
      log(`✓ Copied: src/Wordmark-Black.svg`, 'green');
    } else {
      log(`⚠️  Wordmark not found: ${wordmarkSrc}`, 'yellow');
    }
    // src/ only holds the favicon and logo assets above. (The old src/config,
    // src/core, src/utils "Framework" subsystem was unused by the shipping path
    // — manifest → background.js → dig_client.js WASM → rpc.dig.net — and was removed.)
  } else {
    log(`⚠️  Source directory not found: ${srcDir}`, 'yellow');
  }
  
  // Also copy logo.png to root of dist for popup.html reference
  const logoSrc = path.join(__dirname, 'src', 'logo.png');
  const logoDest = path.join(DIST_DIR, 'logo.png');
  if (fs.existsSync(logoSrc)) {
    fs.copyFileSync(logoSrc, logoDest);
    log(`✓ Copied: logo.png (to root)`, 'green');
  }
  
  
  log('\n✓ All files copied to dist/', 'green');
}

function createZip() {
  log('\n📦 Creating zip file...', 'blue');
  
  try {
    // Check if zip command is available (Windows has it, Linux/Mac might need zip installed)
    const zipCommand = process.platform === 'win32' ? 'powershell' : 'zip';
    
    if (process.platform === 'win32') {
      // Use PowerShell Compress-Archive on Windows
      const zipPath = path.join(__dirname, `dig-network-extension-v${require('./package.json').version}.zip`);
      const distPath = path.join(DIST_DIR, '*');
      
      execSync(
        `powershell -Command "Compress-Archive -Path '${distPath}' -DestinationPath '${zipPath}' -Force"`,
        { stdio: 'inherit' }
      );
      
      log(`✓ Zip created: ${path.basename(zipPath)}`, 'green');
    } else {
      // Use zip command on Unix-like systems
      const zipPath = `dig-network-extension-v${require('./package.json').version}.zip`;
      
      execSync(
        `cd ${DIST_DIR} && zip -r ../${zipPath} .`,
        { stdio: 'inherit' }
      );
      
      log(`✓ Zip created: ${zipPath}`, 'green');
    }
  } catch (error) {
    log('⚠️  Could not create zip file. You can manually zip the dist/ folder.', 'yellow');
    log(`   Error: ${error.message}`, 'yellow');
  }
}

function main() {
  log('🚀 Building DIG Network Browser Extension...\n', 'blue');
  
  // Validate
  const isValid = validateExtension();
  if (!isValid) {
    log('\n❌ Validation failed. Please fix the errors above.', 'red');
    process.exit(1);
  }
  
  // Create dist directory
  createDistDirectory();
  
  // Copy files
  copyFiles();
  
  // Create zip (optional)
  const createZipFile = process.argv.includes('--zip') || process.argv.includes('-z');
  if (createZipFile) {
    createZip();
  }
  
  log('\n✅ Build complete!', 'green');
  log('\n📝 To install the extension:', 'blue');
  log('   1. Open Chrome/Edge/Brave');
  log('   2. Go to chrome://extensions/ (or edge://extensions/)');
  log('   3. Enable "Developer mode"');
  log('   4. Click "Load unpacked"');
  log(`   5. Select the "${path.basename(DIST_DIR)}" folder\n`, 'blue');
}

main();

