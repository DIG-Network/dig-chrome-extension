/**
 * Express test server for DIG Network Browser Extension
 * Serves test resources that match chia://test/* URLs
 * Run with: npm start
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

// Centralized URN utilities. dig-urn.mjs is the shared ES module used by the
// shipping service worker; this CommonJS dev server loads it via dynamic import()
// in startServers() before listening. Bound here so request handlers can use them.
let parseURN, resolveHostToURN, encodeStoreId, decodeStoreId;

const app = express();
const PORT = 80;
const RPC_PORT = 3141;

// Enable CORS for all routes with explicit configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Also add CORS headers manually to ensure they're always present
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Parse JSON bodies
app.use(express.json());

// Helper to create a 1x1 PNG image
function createPlaceholderImage() {
  // Minimal valid 1x1 transparent PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
}

// Helper to create a colored PNG (magenta/purple gradient for DIG branding)
function createColoredImage(width = 200, height = 200, text = '') {
  // For now, return placeholder - in production you'd generate actual images
  // Using a simple approach with a data URI or actual image generation library
  return createPlaceholderImage();
}

// ============================================================================
// RPC Server - Mock Content Store
// ============================================================================

// Mock content store: maps URN hash (SHA-256) to content
// In production, this would be a database or file system
const mockContentStore = new Map();

// Helper to generate content for a URN (same as content server logic)
function generateContentForURN(urn) {
  const parsed = parseURN(urn);
  if (!parsed) {
    return null;
  }
  
  const resourceKey = parsed.resourceKey || 'index.html';
  const ext = path.extname(resourceKey).toLowerCase();
  
  // Generate content based on file extension (same as content server)
  switch (ext) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.ico':
      // Return example image if it exists, otherwise placeholder
      const exampleImagePath = path.join(__dirname, 'example_image.png');
      if (fs.existsSync(exampleImagePath)) {
        return fs.readFileSync(exampleImagePath);
      }
      return createPlaceholderImage();
    
    case '.css':
      return Buffer.from(`
/* DIG Network Test Stylesheet */
/* Requested path: ${resourceKey} */
body {
  background-color: #f5f5f5;
}

.test-stylesheet-loaded {
  color: #9D4EDD;
  font-weight: bold;
}

/* Test background image */
.bg-test {
  background-image: url('chia://urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/background.png');
}

/* Import test */
@import url('chia://urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/imported.css');
      `);
    
    case '.js':
      return Buffer.from(`
// DIG Network Test Script
// Requested path: ${resourceKey}
console.log('DIG Network test script loaded: ${resourceKey}');

// Set a global variable to indicate script loaded
if (typeof window !== 'undefined') {
  window.digTestScriptLoaded = true;
  window.digTestScriptPath = '${resourceKey}';
  
  // Dispatch custom event
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('digTestScriptLoaded', {
      detail: { path: '${resourceKey}' }
    }));
  }
}
      `);
    
    case '.json':
      return Buffer.from(JSON.stringify({
        success: true,
        message: 'DIG Network Test Response',
        path: resourceKey,
        timestamp: new Date().toISOString(),
        data: {
          test: 'This is a test response from the DIG Network RPC server',
          protocol: 'chia://',
          urn: urn
        }
      }));
    
    case '.mp4':
    case '.webm':
    case '.ogg':
      // For video files, return a minimal valid video file or placeholder
      // In a real implementation, this would return actual video content
      // For testing, we'll return a minimal MP4 header that browsers can recognize
      // This is a very basic approach - in production you'd serve actual video
      return createPlaceholderImage(); // Use image as placeholder for now
    
    case '.mp3':
    case '.wav':
    case '.ogg':
      // For audio files, return a minimal valid audio file or placeholder
      // In a real implementation, this would return actual audio content
      // For testing, we'll return a minimal audio file
      // This is a very basic approach - in production you'd serve actual audio
      return Buffer.from('DIG Network Test Audio File - ' + resourceKey);
    
    case '.html':
      return Buffer.from(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DIG Test - ${resourceKey}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background: linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%);
      color: white;
    }
    .container {
      background: rgba(255, 255, 255, 0.1);
      padding: 30px;
      border-radius: 10px;
      border: 2px solid rgba(255, 0, 255, 0.3);
    }
    h1 {
      color: #FF00FF;
      text-shadow: 0 0 10px rgba(255, 0, 255, 0.5);
    }
    .success {
      color: #4CAF50;
      font-weight: bold;
      font-size: 18px;
      margin: 20px 0;
    }
    code {
      background: rgba(0, 0, 0, 0.3);
      padding: 2px 6px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>✅ DIG Network Test Page (RPC)</h1>
    <div class="success">Successfully loaded via RPC protocol!</div>
    <p><strong>Requested Path:</strong> <code>${resourceKey}</code></p>
    <p><strong>Full URN:</strong> <code>${urn}</code></p>
    <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
    <p>This page was successfully loaded through the DIG Network RPC server!</p>
  </div>
</body>
</html>
      `);
    
    default:
      return Buffer.from(`DIG Network Test Server Response\nPath: ${resourceKey}\nExtension: ${ext || 'none'}\nTimestamp: ${new Date().toISOString()}\nURN: ${urn}`);
  }
}

// Initialize mock content store with test URNs (no longer needed, but kept for reference)
// Content is now generated on-demand, so we don't need to pre-load
function initializeMockContentStore() {
  // Content is generated on-demand, no pre-loading needed
  console.log('[RPC] Content store initialized (on-demand generation)');
}

// Generate decoy blob for invalid/non-existent content
function generateDecoyBlob(hash) {
  // Calculate decoy size using logarithmic bands with jitter
  const hashBytes = Buffer.from(hash, 'hex');
  const exponent = (hashBytes[0] % 19) + 9;
  const baseSize = Math.pow(2, exponent);
  const jitterRange = baseSize;
  const jitterSeed = hashBytes.readUInt32BE(1) % 0xFFFFFFFF;
  const jitter = jitterSeed % jitterRange;
  const decoySize = baseSize + jitter;
  
  // Generate deterministic decoy content
  const decoyContent = crypto.pbkdf2Sync(
    hash,
    'dig-decoy',
    1000, // iterations
    decoySize,
    'sha256'
  );
  
  return decoyContent.toString('base64');
}

// Initialize content store on startup
initializeMockContentStore();

// Create RPC server
const rpcApp = express();
rpcApp.use(express.json());
rpcApp.use(cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

// RPC endpoint
rpcApp.post('/rpc', (req, res) => {
  const { jsonrpc, method, params, id } = req.body;
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Validate JSON-RPC 2.0 request
  if (jsonrpc !== '2.0') {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Invalid Request',
        data: 'jsonrpc must be "2.0"'
      },
      id: id || null
    });
  }
  
  // Handle getContent method
  if (method === 'getContent') {
    if (!params || !params.urn) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message: 'Invalid params',
          data: 'urn parameter is required'
        },
        id: id || null
      });
    }
    
    const urn = params.urn;
    
    // Parse URN to validate format
    const parsed = parseURN(urn);
    if (!parsed) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message: 'Invalid params',
          data: 'Invalid URN format'
        },
        id: id || null
      });
    }
    
    console.log(`[RPC] Request for URN: ${urn.substring(0, 60)}...`);
    
    // Generate content for the URN
    const content = generateContentForURN(urn);
    
    if (!content) {
      // Return decoy for non-existent content (privacy-preserving)
      console.log(`[RPC] Content not found for URN, returning decoy`);
      const urnHash = crypto.createHash('sha256').update(urn).digest('hex');
      const decoyBlob = generateDecoyBlob(urnHash);
      const decoyDataUrl = `data:application/octet-stream;base64,${decoyBlob}`;
      
      return res.json({
        jsonrpc: '2.0',
        result: {
          dataUrl: decoyDataUrl
        },
        id: id || null
      });
    }
    
    // Convert content to data URL with proper MIME type
    const contentType = getContentTypeForURN(urn, parsed);
    const base64Content = content.toString('base64');
    
    // Ensure data URL has proper format: data:[<mediatype>][;base64],<data>
    // Add charset for text types
    let mimeType = contentType;
    if (contentType.startsWith('text/') && !contentType.includes('charset')) {
      // Add charset=utf-8 for text types
      if (contentType === 'text/html' || contentType === 'text/css' || contentType === 'text/javascript' || contentType === 'text/plain' || contentType === 'text/markdown') {
        mimeType = `${contentType};charset=utf-8`;
      }
    } else if (contentType === 'application/json' && !contentType.includes('charset')) {
      // JSON should also have charset
      mimeType = `${contentType};charset=utf-8`;
    } else if (contentType === 'application/javascript' && !contentType.includes('charset')) {
      // JavaScript should have charset
      mimeType = `${contentType};charset=utf-8`;
    } else if (contentType === 'application/xml' && !contentType.includes('charset')) {
      // XML should have charset
      mimeType = `${contentType};charset=utf-8`;
    }
    
    const dataUrl = `data:${mimeType};base64,${base64Content}`;
    
    console.log(`[RPC] Returning content as data URL (type: ${mimeType})`);
    
    return res.json({
      jsonrpc: '2.0',
      result: {
        dataUrl: dataUrl
      },
      id: id || null
    });
  }
  
  // Unknown method
  return res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: -32601,
      message: 'Method not found',
      data: `Unknown method: ${method}`
    },
    id: id || null
  });
});

// Helper to determine content type from URN
function getContentTypeForURN(urn, parsed) {
  const resourceKey = parsed.resourceKey || 'index.html';
  
  // Get extension and remove leading dot
  const extWithDot = path.extname(resourceKey).toLowerCase();
  const ext = extWithDot.startsWith('.') ? extWithDot.substring(1) : extWithDot;
  
  // Comprehensive MIME type mapping
  const mimeTypes = {
    // HTML
    'html': 'text/html',
    'htm': 'text/html',
    
    // CSS
    'css': 'text/css',
    
    // JavaScript
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    
    // JSON
    'json': 'application/json',
    'jsonld': 'application/ld+json',
    
    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
    'tif': 'image/tiff',
    
    // Fonts
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    'eot': 'application/vnd.ms-fontobject',
    
    // Audio
    'mp3': 'audio/mpeg',
    'ogg': 'audio/ogg',
    'wav': 'audio/wav',
    'webm': 'audio/webm',
    
    // Video
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'ogv': 'video/ogg',
    
    // Text
    'txt': 'text/plain',
    'md': 'text/markdown',
    'xml': 'application/xml',
    
    // Other
    'pdf': 'application/pdf',
    'zip': 'application/zip',
    'wasm': 'application/wasm'
  };
  
  // If we have a known extension, return its MIME type
  if (ext && mimeTypes[ext]) {
    return mimeTypes[ext];
  }
  
  // Default fallback based on resource key
  if (!ext || ext === '') {
    // No extension - try to infer from resource key
    if (resourceKey === '' || resourceKey === '/') {
      return 'text/html'; // Root typically serves HTML
    }
    // Check if it looks like a directory (ends with /)
    if (resourceKey.endsWith('/')) {
      return 'text/html'; // Directory typically serves index.html
    }
  }
  
  // Unknown extension - use octet-stream
  return 'application/octet-stream';
}

// Handle OPTIONS preflight
rpcApp.options('/rpc', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

// Root route - serve test.html
app.get('/', (req, res) => {
  const testHtmlPath = path.join(__dirname, 'test.html');
  
  console.log(`[${new Date().toISOString()}] GET Request: / (root)`);
  console.log(`  Looking for test.html at: ${testHtmlPath}`);
  console.log(`  File exists: ${fs.existsSync(testHtmlPath)}`);
  
  if (fs.existsSync(testHtmlPath)) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(testHtmlPath, (err) => {
      if (err) {
        // Don't try to send error response if request was aborted or response already sent
        if (err.code === 'ECONNABORTED' || res.headersSent) {
          console.log('Request aborted or response already sent, skipping error response');
          return;
        }
        console.error('Error sending test.html:', err);
        if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to serve test.html', details: err.message });
        }
      } else {
        console.log('Successfully sent test.html');
      }
    });
  } else {
    console.warn('test.html not found, serving API info');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      message: 'DIG Network Test Server',
      version: '1.0.0',
      endpoints: [
        '/urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/* - All test resources',
        '/urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/*.png - Test images',
        '/urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/*.css - Test stylesheets',
        '/urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/*.js - Test scripts',
        '/urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/*.html - Test HTML pages'
      ],
      note: 'test.html not found, serving API info instead',
      testHtmlPath: testHtmlPath
    });
  }
});

// Middleware to handle dig.local and localhost URL schemes (must come before URN processing)
app.use((req, res, next) => {
  const host = req.get('host') || req.headers.host || '';
  const hostname = host.split(':')[0]; // Remove port if present
  const pathname = req.path;
  
  // Check if this is a DIG Network request (dig.local, localhost subdomain, or 127.0.0.1 subdomain)
  const isDigRequest = hostname.includes('dig.local') || 
                       (hostname.includes('localhost') && hostname !== 'localhost') ||
                       (hostname.includes('127.0.0.1') && hostname !== '127.0.0.1');
  
  if (!isDigRequest) {
    return next();
  }
  
  console.log(`[${new Date().toISOString()}] DIG Network request: ${req.method} ${req.originalUrl} (Host: ${hostname})`);
  
  // Special case: If it's the base dig.local domain with root path, let it fall through to root route handler
  if ((hostname === 'dig.local' || hostname === 'localhost' || hostname === '127.0.0.1') && pathname === '/') {
    console.log('  Base domain root path, passing to root route handler');
    return next();
  }
  
  // 0. Handle query parameter format: dig.local?urn=<urn> -> redirect to subdomain format
  // This is different from dig.local/<urn> which serves content directly
  if (hostname === 'dig.local' && req.query && req.query.urn) {
    const urnString = req.query.urn;
    console.log(`  Query parameter format detected: urn=${urnString}`);
    const parsed = parseURN(urnString);
    if (parsed && parsed.storeId) {
      try {
        const encodedStoreId = encodeStoreId(parsed.storeId);
        const resourceKey = parsed.resourceKey || '';
        // Redirect to subdomain format: http://{encodedStoreId}.dig.local/{resourceKey}
        const redirectUrl = `http://${encodedStoreId}.dig.local${PORT !== 80 ? ':' + PORT : ''}/${resourceKey}`;
        console.log(`  Redirecting query format to subdomain: ${redirectUrl}`);
        return res.redirect(302, redirectUrl);
      } catch (e) {
        console.error('Failed to encode store ID for redirect:', e);
        return res.status(400).json({ error: 'Invalid store ID format' });
      }
    } else {
      console.warn('  Invalid URN in query parameter');
      return res.status(400).json({ error: 'Invalid URN format in query parameter' });
    }
  }
  
  // 1. Handle path-based format: /{storeId}/{resourceKey} -> redirect to subdomain
  // Only for dig.local (not localhost, as localhost subdomains might not resolve)
  // For localhost/127.0.0.1, skip redirect and let URN resolution handle it directly
  if (hostname === 'dig.local' && pathname.match(/^\/[a-f0-9]{64}(\/|$)/i)) {
    const pathMatch = pathname.match(/^\/([a-f0-9]{64})(?:\/(.+))?$/i);
    if (pathMatch) {
      const storeId = pathMatch[1].toLowerCase();
      const resourceKey = pathMatch[2] || '';
      try {
        const encodedStoreId = encodeStoreId(storeId);
        // Use dig.local for redirect (not localhost)
        const redirectUrl = `http://${encodedStoreId}.dig.local${PORT !== 80 ? ':' + PORT : ''}/${resourceKey}`;
        console.log(`  Redirecting path-based to subdomain: ${redirectUrl}`);
        return res.redirect(302, redirectUrl);
      } catch (e) {
        console.error('Failed to encode store ID for redirect:', e);
        return res.status(400).json({ error: 'Invalid store ID format' });
      }
    }
  }
  
  // 2. Handle path-based URN format: dig.local/urn:dig:chia:... -> redirect to subdomain format
  // This is different from dig.local?urn=... which also redirects to subdomain
  if (hostname === 'dig.local' && pathname.startsWith('/urn:dig:')) {
    const urnString = pathname.substring(1); // Remove leading slash
    const parsed = parseURN(urnString);
    if (parsed) {
      try {
        const encodedStoreId = encodeStoreId(parsed.storeId);
        const resourceKey = parsed.resourceKey || '';
        
        // Build subdomain URL based on whether roothash is present
        let redirectUrl;
        if (parsed.roothash) {
          // Specific version: http://{encodedStoreId}.{encodedRootHash}.dig.local/{resourceKey}
          const encodedRootHash = encodeStoreId(parsed.roothash);
          redirectUrl = `http://${encodedStoreId}.${encodedRootHash}.dig.local${PORT !== 80 ? ':' + PORT : ''}/${resourceKey}`;
        } else {
          // Latest version: http://{encodedStoreId}.dig.local/{resourceKey}
          redirectUrl = `http://${encodedStoreId}.dig.local${PORT !== 80 ? ':' + PORT : ''}/${resourceKey}`;
        }
        
        console.log(`  Redirecting path-based URN to subdomain: ${redirectUrl}`);
        return res.redirect(302, redirectUrl);
      } catch (e) {
        console.error('Failed to encode store ID for redirect:', e);
        return res.status(400).json({ error: 'Invalid URN format' });
      }
    }
  }
  
  // 2. Resolve hostname to URN
  const urn = resolveHostToURN(hostname, pathname);
  
  if (urn) {
    // Store URN in request for later use
    req.digURN = urn;
    req.digParsed = parseURN(urn);
    console.log(`  Resolved to URN: ${urn}`);
    if (req.digParsed) {
      console.log(`  Parsed: chain=${req.digParsed.chain}, storeId=${req.digParsed.storeId.substring(0, 16)}..., roothash=${req.digParsed.roothash ? req.digParsed.roothash.substring(0, 16) + '...' : 'null'}, resourceKey=${req.digParsed.resourceKey || '(empty)'}`);
    }
  }
  
  next();
});

// Handle URN paths (urn:dig:chia:...) and dig.local subdomain requests
app.use((req, res, next) => {
  // Check if we have a URN from subdomain resolution or direct path
  let urn = req.digURN;
  let parsed = req.digParsed;
  
  // Also check if the path starts with /urn:dig:chia: (direct URN format)
  if (!urn && req.path && req.path.startsWith('/urn:dig:')) {
    urn = req.path.substring(1); // Remove leading slash
    parsed = parseURN(urn);
    req.digURN = urn;
    req.digParsed = parsed;
  }
  
  // Process if we have a URN
  if (urn && parsed) {
    // Get resource key from parsed URN
    let requestedPath = parsed.resourceKey || '';
    
    // If no resource key, default to index.html
    if (!requestedPath || requestedPath === '') {
      requestedPath = 'index.html';
    }
    
    const ext = path.extname(requestedPath).toLowerCase();
  
  console.log(`[${new Date().toISOString()}] ${req.method} Request: ${req.originalUrl}`);
  console.log(`  req.path: ${req.path}, extracted: ${requestedPath}, ext: ${ext}`);
  
  // Set CORS headers explicitly for each response
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', '*');
  
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  // Determine content type and response based on file extension
  switch (ext) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.ico':
      // Try to serve example_image.png if it exists, otherwise use placeholder
      const exampleImagePath = path.join(__dirname, 'example_image.png');
      if (fs.existsSync(exampleImagePath)) {
        res.setHeader('Content-Type', ext === '.ico' ? 'image/x-icon' : 
                      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                      ext === '.gif' ? 'image/gif' :
                      ext === '.webp' ? 'image/webp' : 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.sendFile(exampleImagePath, (err) => {
          if (err) {
            // Don't try to send error response if request was aborted or response already sent
            if (err.code === 'ECONNABORTED' || res.headersSent) {
              console.log('Request aborted or response already sent, skipping error response');
              return;
            }
            console.error('Error sending example_image.png:', err);
            // Fallback to placeholder only if headers haven't been sent
            if (!res.headersSent) {
            res.setHeader('Content-Type', 'image/png');
            res.send(createPlaceholderImage());
            }
          }
        });
      } else {
        // Fallback to placeholder if example_image.png doesn't exist
        res.setHeader('Content-Type', ext === '.ico' ? 'image/x-icon' : 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(createPlaceholderImage());
      }
      break;
    
    case '.css':
      // Return test CSS
      res.setHeader('Content-Type', 'text/css');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(`
/* DIG Network Test Stylesheet */
/* Requested path: ${requestedPath} */
body {
  background-color: #f5f5f5;
}

.test-stylesheet-loaded {
  color: #9D4EDD;
  font-weight: bold;
}

/* Test background image */
.bg-test {
  background-image: url('chia://urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/background.png');
}

/* Import test */
@import url('chia://urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/imported.css');
      `);
      break;
    
    case '.js':
      // Return test JavaScript
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(`
// DIG Network Test Script
// Requested path: ${requestedPath}
console.log('DIG Network test script loaded: ${requestedPath}');

// Set a global variable to indicate script loaded
if (typeof window !== 'undefined') {
  window.digTestScriptLoaded = true;
  window.digTestScriptPath = '${requestedPath}';
  
  // Dispatch custom event
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('digTestScriptLoaded', {
      detail: { path: '${requestedPath}' }
    }));
  }
}
      `);
      break;
    
    case '.json':
      // Return test JSON data
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({
        success: true,
        message: 'DIG Network Test Response',
        path: requestedPath,
        timestamp: new Date().toISOString(),
        data: {
          test: 'This is a test response from the DIG Network test server',
          protocol: 'chia://',
          redirected: true,
          localhost: `http://localhost:${PORT}${req.path}`
        }
      });
      break;
    
    case '.html':
      // Return test HTML page
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DIG Test - ${requestedPath}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background: linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%);
      color: white;
    }
    .container {
      background: rgba(255, 255, 255, 0.1);
      padding: 30px;
      border-radius: 10px;
      border: 2px solid rgba(255, 0, 255, 0.3);
    }
    h1 {
      color: #FF00FF;
      text-shadow: 0 0 10px rgba(255, 0, 255, 0.5);
    }
    .success {
      color: #4CAF50;
      font-weight: bold;
      font-size: 18px;
      margin: 20px 0;
    }
    code {
      background: rgba(0, 0, 0, 0.3);
      padding: 2px 6px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>✅ DIG Network Test Page</h1>
    <div class="success">Successfully loaded via chia:// protocol!</div>
    <p><strong>Requested Path:</strong> <code>${requestedPath}</code></p>
    <p><strong>Full URL:</strong> <code>chia://test/${requestedPath}</code></p>
    <p><strong>Redirected To:</strong> <code>http://localhost:${PORT}${req.path}</code></p>
    <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
    <p>This page was successfully loaded through the DIG Network Browser Extension!</p>
    <p><a href="/" style="color: #9D4EDD;">← Back to test page</a></p>
  </div>
</body>
</html>
      `);
      break;
    
    case '.mp4':
    case '.mp3':
    case '.webm':
    case '.ogg':
      // Return placeholder for media files
      res.setHeader('Content-Type', ext === '.mp4' || ext === '.webm' ? 'video/mp4' : 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      // For actual media, you'd serve real files, but for testing we'll return a minimal response
      res.json({
        message: 'Media file placeholder',
        path: requestedPath,
        note: 'In production, this would serve actual media files'
      });
      break;
    
    default:
      // Default response for unknown file types
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(`DIG Network Test Server Response\nPath: ${requestedPath}\nExtension: ${ext || 'none'}\nTimestamp: ${new Date().toISOString()}`);
  }
    // Don't call next() - we've handled the request
    return;
  }
  // If not a URN path, continue to next middleware
  next();
});

// POST requests are handled by the same middleware above

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    message: 'Resource not found on DIG Network test server'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// Load the shared URN ES module, then start both servers. Dynamic import() lets this
// CommonJS file consume the single dig-urn.mjs ESM source of truth.
async function startServers() {
  ({ parseURN, resolveHostToURN, encodeStoreId, decodeStoreId } = await import('../dig-urn.mjs'));

// Start content server - listen on all interfaces (0.0.0.0) to accept dig.local requests
// When dig.local is mapped to 127.0.0.1 in hosts file, requests will come here
app.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   DIG Network Content Server                            ║');
  console.log('║   Listening on all interfaces (0.0.0.0):' + PORT.toString().padEnd(25) + '║');
  console.log('║   Accessible via:                                       ║');
  console.log('║     - http://localhost:' + PORT.toString().padEnd(30) + '║');
  console.log('║     - http://127.0.0.1:' + PORT.toString().padEnd(30) + '║');
  console.log('║     - http://dig.local:' + PORT.toString().padEnd(30) + '║');
  console.log('║                                                          ║');
  console.log('║   Supported URL Schemes:                                 ║');
  console.log('║     1. Direct URN:                                       ║');
  console.log('║        http://dig.local/urn:dig:chia:.../{resource}      ║');
  console.log('║     2. Path-based (redirects to subdomain):              ║');
  console.log('║        http://dig.local/{storeId}/{resource}             ║');
  console.log('║     3. Subdomain (latest version):                        ║');
  console.log('║        http://{encodedStoreId}.dig.local/{resource}     ║');
  console.log('║     4. Subdomain (specific version):                      ║');
  console.log('║        http://{storeId}.{rootHash}.dig.local/{resource}   ║');
  console.log('║                                                          ║');
  console.log('║   Note: Add "127.0.0.1 dig.local" to your hosts file    ║');
  console.log('║   to enable dig.local domain access                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Ready to serve test resources!');
});

// Start RPC server - listen on all interfaces (0.0.0.0) to accept rpc.dig.local requests
rpcApp.listen(RPC_PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   DIG Network RPC Server                                 ║');
  console.log('║   Listening on all interfaces (0.0.0.0):' + RPC_PORT.toString().padEnd(25) + '║');
  console.log('║   Accessible via:                                       ║');
  console.log('║     - http://localhost:' + RPC_PORT.toString().padEnd(30) + '║');
  console.log('║     - http://127.0.0.1:' + RPC_PORT.toString().padEnd(30) + '║');
  console.log('║     - http://rpc.dig.local:' + RPC_PORT.toString().padEnd(25) + '║');
  console.log('║                                                          ║');
  console.log('║   JSON-RPC 2.0 Endpoint:                                ║');
  console.log('║     POST http://rpc.dig.local:' + RPC_PORT.toString().padEnd(20) + '/rpc ║');
  console.log('║                                                          ║');
  console.log('║   Methods:                                               ║');
  console.log('║     - getContent: Retrieve content by URN hash            ║');
  console.log('║                                                          ║');
  console.log('║   Note: Add "127.0.0.1 rpc.dig.local" to your hosts     ║');
  console.log('║   file to enable rpc.dig.local domain access            ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('RPC server ready!');
  console.log('Press Ctrl+C to stop the servers.');
});
}

startServers().catch((err) => {
  console.error('Failed to start servers:', err);
  process.exit(1);
});

