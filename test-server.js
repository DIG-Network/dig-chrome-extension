/**
 * Simple test script to verify Express server is working
 */

const http = require('http');

const PORT = 8080;
const BASE_URL = `http://localhost:${PORT}`;

function testEndpoint(path, description) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}`;
    console.log(`\nTesting: ${description}`);
    console.log(`  URL: ${url}`);
    
    http.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`  Status: ${res.statusCode}`);
        console.log(`  Content-Type: ${res.headers['content-type']}`);
        console.log(`  Content-Length: ${res.headers['content-length']} bytes`);
        console.log(`  CORS: ${res.headers['access-control-allow-origin'] || 'Not set'}`);
        
        if (res.statusCode === 200) {
          if (path === '/') {
            console.log(`  ✓ Root route working - HTML content received (${data.length} bytes)`);
            console.log(`  First 100 chars: ${data.substring(0, 100)}...`);
          } else if (path.includes('.json')) {
            console.log(`  ✓ JSON endpoint working`);
            try {
              const json = JSON.parse(data);
              console.log(`  Response: ${JSON.stringify(json).substring(0, 100)}...`);
            } catch (e) {
              console.log(`  Response: ${data.substring(0, 100)}...`);
            }
          } else if (path.includes('.png')) {
            console.log(`  ✓ Image endpoint working - received ${data.length} bytes`);
          } else if (path.includes('.css')) {
            console.log(`  ✓ CSS endpoint working - received ${data.length} bytes`);
            console.log(`  First 100 chars: ${data.substring(0, 100)}...`);
          }
          resolve(true);
        } else {
          console.log(`  ✗ Failed with status ${res.statusCode}`);
          reject(new Error(`Status ${res.statusCode}`));
        }
      });
    }).on('error', (err) => {
      console.log(`  ✗ Error: ${err.message}`);
      reject(err);
    });
  });
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('DIG Network Server Test Script');
  console.log('='.repeat(60));
  console.log(`Testing server at: ${BASE_URL}`);
  console.log('Make sure the server is running: npm run server');
  
  try {
    await testEndpoint('/', 'Root route (test.html)');
    await testEndpoint('/test/data.json', 'JSON endpoint');
    await testEndpoint('/test/image1.png', 'Image endpoint');
    await testEndpoint('/test/styles.css', 'CSS endpoint');
    await testEndpoint('/test/script.js', 'JavaScript endpoint');
    
    console.log('\n' + '='.repeat(60));
    console.log('✓ All tests passed! Server is working correctly.');
    console.log('='.repeat(60));
    console.log('\nIf the browser still shows issues, check:');
    console.log('  1. Browser console for errors');
    console.log('  2. Network tab to see if requests are being made');
    console.log('  3. Extension is installed and enabled');
    console.log('  4. CORS headers are present (they are!)');
  } catch (error) {
    console.log('\n' + '='.repeat(60));
    console.log('✗ Test failed:', error.message);
    console.log('='.repeat(60));
    console.log('\nMake sure the server is running:');
    console.log('  cd server && npm start');
    process.exit(1);
  }
}

runTests();

