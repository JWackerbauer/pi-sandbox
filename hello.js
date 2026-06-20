const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Hello World</title>
      <style>
        body {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #667eea, #764ba2);
          color: white;
        }
        h1 { font-size: 4rem; }
      </style>
    </head>
    <body>
      <h1>👋 Hello, World!</h1>
    </body>
    </html>
  `);
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
