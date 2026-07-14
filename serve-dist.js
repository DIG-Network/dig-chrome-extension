const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5174;
const DIR = path.join(__dirname, 'dist-web');

const server = http.createServer((req, res) => {
  let filePath = path.join(DIR, decodeURIComponent(req.url));
  if (req.url === '/') filePath = path.join(DIR, 'popup.html');
  if (!filePath.startsWith(DIR)) filePath = path.join(DIR, 'popup.html');
  
  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end();
        return;
      }
      
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf',
      };
      
      const contentType = contentTypes[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
      res.end(content);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Server started on port ${PORT}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
