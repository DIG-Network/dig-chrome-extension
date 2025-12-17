/**
 * Express test server for DIG Network Browser Extension
 * Serves test resources that match dig://test/* URLs
 * Run with: npm start
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 8080;

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
        console.error('Error sending test.html:', err);
        res.status(500).json({ error: 'Failed to serve test.html', details: err.message });
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

// Handle URN paths (urn:dig:chia:...)
// Use a middleware function that matches any path starting with /urn:dig:chia:
app.use((req, res, next) => {
  // Check if the path starts with /urn:dig:chia:
  if (req.path && req.path.startsWith('/urn:dig:chia:')) {
    // Extract everything after /urn:dig:chia:.../
    // req.path will be like '/urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/image1.png'
    let requestedPath = req.path;
    // Remove the URN prefix to get just the resource path
    // Match: /urn:dig:chia:STORE_ID/path/to/resource
    const urnMatch = requestedPath.match(/^\/urn:dig:chia:[^\/]+\/(.+)$/);
    if (urnMatch) {
      requestedPath = urnMatch[1]; // Extract the resource path after the URN
    } else {
      // If no path after URN, it might be just the store ID
      // Check if it ends with just the store ID
      const storeIdMatch = requestedPath.match(/^\/urn:dig:chia:([^\/]+)$/);
      if (storeIdMatch) {
        requestedPath = 'index.html'; // Default to index.html for store root
      } else if (requestedPath.startsWith('/')) {
        requestedPath = requestedPath.substring(1);
      }
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
            console.error('Error sending example_image.png:', err);
            // Fallback to placeholder
            res.setHeader('Content-Type', 'image/png');
            res.send(createPlaceholderImage());
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
  background-image: url('dig://urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/background.png');
}

/* Import test */
@import url('dig://urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/imported.css');
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
          protocol: 'dig://',
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
    <div class="success">Successfully loaded via dig:// protocol!</div>
    <p><strong>Requested Path:</strong> <code>${requestedPath}</code></p>
    <p><strong>Full URL:</strong> <code>dig://test/${requestedPath}</code></p>
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

// Start server
app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   DIG Network Test Server                               ║');
  console.log('║   Listening on http://localhost:' + PORT.toString().padEnd(35) + '║');
  console.log('║                                                          ║');
  console.log('║   This server serves test resources for the             ║');
  console.log('║   DIG Network Browser Extension                           ║');
  console.log('║                                                          ║');
  console.log('║   All dig://test/* URLs will be redirected here         ║');
  console.log('║   when the extension is active                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Ready to serve test resources!');
  console.log('Press Ctrl+C to stop the server.');
});

