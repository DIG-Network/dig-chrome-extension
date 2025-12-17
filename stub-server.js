/**
 * Stub server for DIG Network Extension
 * This is a simple Node.js server that serves placeholder responses
 * Run this with: node stub-server.js
 */

const http = require('http');
const url = require('url');
const path = require('path');

const PORT = 8080;

// Placeholder image (1x1 transparent PNG)
const PLACEHOLDER_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const ext = path.extname(pathname).toLowerCase();
  
  // Determine if it's an image request
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp'].includes(ext);
  
  if (isImage) {
    // Return placeholder image
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': PLACEHOLDER_IMAGE.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(PLACEHOLDER_IMAGE);
  } else {
    // Return placeholder JSON/text response
    const placeholderResponse = JSON.stringify({
      message: 'DIG Network Extension - Stub Response',
      path: pathname,
      timestamp: new Date().toISOString(),
      note: 'This is a placeholder response. The actual server implementation will be added later.'
    });
    
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(placeholderResponse),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(placeholderResponse);
  }
});

server.listen(PORT, () => {
  console.log(`DIG Network stub server running on http://localhost:${PORT}`);
  console.log('This server will serve placeholder responses for dig:// protocol requests.');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please stop the other service or change the port.`);
  } else {
    console.error('Server error:', err);
  }
});

