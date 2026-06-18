# DIG Network Test Server

Express server that serves test resources for the DIG Network Browser Extension.

## Purpose

This server provides test endpoints that match the `dig://test/*` URLs used in the test page. When the browser extension intercepts `dig://` protocol requests, it redirects them to this localhost server.

## Installation

```bash
cd server
npm install
```

## Usage

Start the server:

```bash
npm start
```

The server will run on `http://localhost:8080` (matching the port configured in the extension).

## Endpoints

The server handles all `/test/*` routes and returns appropriate responses based on file extension:

- **Images** (`.png`, `.jpg`, `.ico`, etc.) - Returns placeholder PNG images
- **Stylesheets** (`.css`) - Returns test CSS with DIG Network branding
- **Scripts** (`.js`) - Returns test JavaScript that logs to console
- **JSON** (`.json`) - Returns test JSON data
- **HTML** (`.html`) - Returns test HTML pages
- **Media** (`.mp4`, `.mp3`, etc.) - Returns placeholder responses

## Example Requests

- `http://localhost:8080/test/image1.png` - Returns placeholder image
- `http://localhost:8080/test/data.json` - Returns test JSON
- `http://localhost:8080/test/script.js` - Returns test JavaScript
- `http://localhost:8080/test/page.html` - Returns test HTML page

## Testing with Extension

1. Start this server: `npm start`
2. Activate the DIG Network Browser Extension
3. Open `test.html` in your browser
4. All `dig://test/*` requests will be redirected to this server
5. Check the browser console and Network tab to verify redirections

## Notes

- The server uses CORS to allow requests from any origin
- All responses include `Cache-Control: no-cache` headers
- The server logs all requests to the console for debugging

