const { Server } = require('proxy-chain');
const http = require('http');
const request = require('request');

(async () => {
    // Create a target server
    const targetServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello World!');
    });
    await new Promise((resolve) => targetServer.listen(0, resolve));
    const targetPort = targetServer.address().port;

    // Create a proxy server
    const server = new Server({
        port: 0,
        verbose: true,
    });

    server.on('requestFinished', ({ id, connectionId, request }) => {
        console.log(`Request finished: { id: ${id}, connectionId: ${connectionId}, method: ${request.method}, url: ${request.url} }`);
    });

    await server.listen();
    const proxyPort = server.port;

    console.log(`Proxy server listening on port ${proxyPort}`);
    console.log(`Target server listening on port ${targetPort}`);

    // Make a request through the proxy
    await new Promise((resolve, reject) => {
        request({
            url: `http://127.0.0.1:${targetPort}`,
            proxy: `http://127.0.0.1:${proxyPort}`,
        }, (error, response, body) => {
            if (error) return reject(error);
            console.log(`Response body: ${body}`);
            resolve();
        });
    });

    // Close servers
    await server.close(true);
    await new Promise((resolve) => targetServer.close(resolve));
    console.log('Servers closed.');
})(); 