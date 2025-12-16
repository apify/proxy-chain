const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const util = require('util');
const { expect } = require('chai');
const request = require('request');

const { Server } = require('../src/index');
const { TargetServer } = require('./utils/target_server');

const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const requestPromised = (opts) => {
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) {
                return reject(error);
            }
            resolve({ response, body });
        });
    });
};

describe('forward.ts TLS overhead with HTTPS upstream', () => {
    it('should track bytes correctly with HTTP upstream proxy', async function () {
        this.timeout(30000);

        let targetServer;
        let httpUpstreamServer;
        let mainProxy;

        try {
            targetServer = new TargetServer({
                port: 0,
                useSsl: false,
            });
            await targetServer.listen();
            const targetPort = targetServer.httpServer.address().port;
            const targetUrl = `http://127.0.0.1:${targetPort}/`;

            let httpUpstreamRawTxBytes = 0;
            let httpUpstreamRawRxBytes = 0;

            httpUpstreamServer = http.createServer(upstreamListener);

            httpUpstreamServer.on('connection', (rawSocket) => {
                const initialRx = rawSocket.bytesRead || 0;
                const initialTx = rawSocket.bytesWritten || 0;

                rawSocket.on('close', () => {
                    const totalRx = rawSocket.bytesRead - initialRx;
                    const totalTx = rawSocket.bytesWritten - initialTx;

                    httpUpstreamRawRxBytes += totalRx;
                    httpUpstreamRawTxBytes += totalTx;
                });
            });

            await util.promisify(httpUpstreamServer.listen).bind(httpUpstreamServer)(0);
            const httpUpstreamPort = httpUpstreamServer.address().port;
            const httpUpstreamUrl = `http://127.0.0.1:${httpUpstreamPort}`;

            let stats = null;
            mainProxy = new Server({
                port: 0,
                prepareRequestFunction: () => {
                    return {
                        upstreamProxyUrl: httpUpstreamUrl,
                    };
                },
            });

            mainProxy.on('connectionClosed', ({ stats: connectionStats }) => {
                stats = connectionStats;
            });

            await mainProxy.listen();
            const proxyPort = mainProxy.port;

            const result = await requestPromised({
                url: targetUrl,
                proxy: `http://127.0.0.1:${proxyPort}`,
            });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(stats).to.not.be.null;
            expect(result.body).to.equal('It works!');

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(stats.trgRxBytes).to.be.greaterThan(0);
            expect(stats.trgTxBytes).to.be.greaterThan(0);
            expect(httpUpstreamRawRxBytes).to.be.greaterThan(0);
            expect(httpUpstreamRawTxBytes).to.be.greaterThan(0);

            expect(stats.trgRxBytes).to.be.equal(httpUpstreamRawTxBytes, `HTTP baseline: counted trgRxBytes ${stats.trgRxBytes} not equal to actual upstream count ${httpUpstreamRawTxBytes}`)
            expect(stats.trgTxBytes).to.be.equal(httpUpstreamRawRxBytes, `HTTP baseline: counted trgTxBytes ${stats.trgTxBytes} not equal to actual upstream count ${httpUpstreamRawRxBytes}`)

        } finally {
            if (targetServer) await targetServer.close();
            if (httpUpstreamServer) await util.promisify(httpUpstreamServer.close).bind(httpUpstreamServer)();
            if (mainProxy) await mainProxy.close();
        }
    });

    it('should demonstrate missing TLS overhead with HTTPS upstream proxy', async function () {
        this.timeout(30000);

        let targetServer;
        let httpsUpstreamServer;
        let mainProxy;

        try {
            targetServer = new TargetServer({
                port: 0,
                useSsl: false,
            });
            await targetServer.listen();
            const targetPort = targetServer.httpServer.address().port;
            const targetUrl = `http://127.0.0.1:${targetPort}/`;

            let httpsUpstreamRawTxBytes = 0;
            let httpsUpstreamRawRxBytes = 0;

            httpsUpstreamServer = https.createServer({key: sslKey, cert: sslCrt,}, upstreamListener);

            httpsUpstreamServer.on('connection', (rawSocket) => {
                const initialRx = rawSocket.bytesRead || 0;
                const initialTx = rawSocket.bytesWritten || 0;

                rawSocket.on('close', () => {
                    const totalRx = rawSocket.bytesRead - initialRx;
                    const totalTx = rawSocket.bytesWritten - initialTx;

                    httpsUpstreamRawRxBytes += totalRx;
                    httpsUpstreamRawTxBytes += totalTx;
                });
            });

            await util.promisify(httpsUpstreamServer.listen).bind(httpsUpstreamServer)(0);
            const httpsUpstreamPort = httpsUpstreamServer.address().port;
            const httpsUpstreamUrl = `https://127.0.0.1:${httpsUpstreamPort}`;

            let stats = null;
            mainProxy = new Server({
                port: 0,
                prepareRequestFunction: () => {
                    return {
                        upstreamProxyUrl: httpsUpstreamUrl,
                        ignoreUpstreamProxyCertificate: true,
                    };
                },
            });

            mainProxy.on('connectionClosed', ({ stats: connectionStats }) => {
                stats = connectionStats;
            });

            await mainProxy.listen();
            const proxyPort = mainProxy.port;

            const result = await requestPromised({
                url: targetUrl,
                proxy: `http://127.0.0.1:${proxyPort}`,
            });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(stats).to.not.be.null;
            expect(result.body).to.equal('It works!');

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(stats.trgRxBytes).to.be.equal(httpsUpstreamRawTxBytes, `counted trgRxBytes ${stats.trgRxBytes} not equal to actual upstream count ${httpsUpstreamRawTxBytes}`)
            expect(stats.trgTxBytes).to.be.equal(httpsUpstreamRawRxBytes, `counted trgTxBytes ${stats.trgRxBytes} not equal to actual upstream count ${httpsUpstreamRawTxBytes}`)

        } finally {
            if (targetServer) await targetServer.close();
            if (httpsUpstreamServer) await util.promisify(httpsUpstreamServer.close).bind(httpsUpstreamServer)();
            if (mainProxy) await mainProxy.close();
        }
    });
});

describe('chain.ts TLS overhead with HTTPS upstream', () => {
    it('should track bytes correctly with HTTP upstream proxy (chain handler)', async function () {
        this.timeout(30000);

        let targetServer;
        let httpUpstreamServer;
        let mainProxy;

        try {
            targetServer = new TargetServer({
                port: 0,
                useSsl: true,
                sslKey,
                sslCrt,
            });
            await targetServer.listen();
            const targetPort = targetServer.httpServer.address().port;
            const targetUrl = `https://127.0.0.1:${targetPort}/`;

            let httpUpstreamRawTxBytes = 0;
            let httpUpstreamRawRxBytes = 0;

            httpUpstreamServer = http.createServer();

            httpUpstreamServer.on('connect', (req, clientSocket, head) => {
                const [targetHost, targetPortStr] = req.url.split(':');
                const targetPort = parseInt(targetPortStr, 10);

                const serverSocket = require('net').connect(targetPort, targetHost, () => {
                    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    serverSocket.write(head);
                    serverSocket.pipe(clientSocket);
                    clientSocket.pipe(serverSocket);
                });

                serverSocket.on('error', (err) => {
                    console.error('Upstream CONNECT error:', err.message);
                    clientSocket.end();
                });
            });

            httpUpstreamServer.on('connection', (rawSocket) => {
                const initialRx = rawSocket.bytesRead || 0;
                const initialTx = rawSocket.bytesWritten || 0;

                rawSocket.on('close', () => {
                    const totalRx = rawSocket.bytesRead - initialRx;
                    const totalTx = rawSocket.bytesWritten - initialTx;

                    httpUpstreamRawRxBytes += totalRx;
                    httpUpstreamRawTxBytes += totalTx;
                });
            });

            await util.promisify(httpUpstreamServer.listen).bind(httpUpstreamServer)(0);
            const httpUpstreamPort = httpUpstreamServer.address().port;
            const httpUpstreamUrl = `http://127.0.0.1:${httpUpstreamPort}`;

            let stats = null;
            mainProxy = new Server({
                port: 0,
                prepareRequestFunction: () => {
                    return {
                        upstreamProxyUrl: httpUpstreamUrl,
                    };
                },
            });

            mainProxy.on('connectionClosed', ({ stats: connectionStats }) => {
                stats = connectionStats;
            });

            await mainProxy.listen();
            const proxyPort = mainProxy.port;

            const result = await requestPromised({
                url: targetUrl,
                proxy: `http://127.0.0.1:${proxyPort}`,
                strictSSL: false,
            });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(stats).to.not.be.null;
            expect(result.body).to.equal('It works!');

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(stats.trgRxBytes).to.be.greaterThan(0);
            expect(stats.trgTxBytes).to.be.greaterThan(0);
            expect(httpUpstreamRawRxBytes).to.be.greaterThan(0);
            expect(httpUpstreamRawTxBytes).to.be.greaterThan(0);

            expect(stats.trgRxBytes).to.be.equal(httpUpstreamRawTxBytes, `HTTP baseline (chain): counted trgRxBytes ${stats.trgRxBytes} not equal to actual upstream count ${httpUpstreamRawTxBytes}`)
            expect(stats.trgTxBytes).to.be.equal(httpUpstreamRawRxBytes, `HTTP baseline (chain): counted trgTxBytes ${stats.trgTxBytes} not equal to actual upstream count ${httpUpstreamRawRxBytes}`)

        } finally {
            if (targetServer) await targetServer.close();
            if (httpUpstreamServer) await util.promisify(httpUpstreamServer.close).bind(httpUpstreamServer)();
            if (mainProxy) await mainProxy.close();
        }
    });

    it('should demonstrate missing TLS overhead with HTTPS upstream proxy (chain handler)', async function () {
        this.timeout(30000);

        let targetServer;
        let httpsUpstreamServer;
        let mainProxy;

        try {
            targetServer = new TargetServer({
                port: 0,
                useSsl: true,
                sslKey,
                sslCrt,
            });
            await targetServer.listen();
            const targetPort = targetServer.httpServer.address().port;
            const targetUrl = `https://127.0.0.1:${targetPort}/`;

            let httpsUpstreamRawTxBytes = 0;
            let httpsUpstreamRawRxBytes = 0;

            httpsUpstreamServer = https.createServer({key: sslKey, cert: sslCrt}, (req, res) => {
                res.writeHead(405, { 'Content-Type': 'text/plain' });
                res.end('Method Not Allowed - Use CONNECT');
            });

            httpsUpstreamServer.on('connect', (req, clientSocket, head) => {
                const target = req.url !== '/' ? req.url : req.headers.host;

                const [targetHost, targetPortStr] = target.split(':');
                const targetPort = parseInt(targetPortStr, 10);

                if (isNaN(targetPort)) {
                    console.error('Invalid target port:', target);
                    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                    return;
                }

                const serverSocket = require('net').connect(targetPort, targetHost, () => {
                    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    serverSocket.write(head);
                    serverSocket.pipe(clientSocket);
                    clientSocket.pipe(serverSocket);
                });

                serverSocket.on('error', (err) => {
                    console.error('HTTPS upstream CONNECT error:', err.message);
                    clientSocket.end();
                });
            });

            httpsUpstreamServer.on('connection', (rawSocket) => {
                const initialRx = rawSocket.bytesRead || 0;
                const initialTx = rawSocket.bytesWritten || 0;

                rawSocket.on('close', () => {
                    const totalRx = rawSocket.bytesRead - initialRx;
                    const totalTx = rawSocket.bytesWritten - initialTx;

                    httpsUpstreamRawRxBytes += totalRx;
                    httpsUpstreamRawTxBytes += totalTx;
                });
            });

            await util.promisify(httpsUpstreamServer.listen).bind(httpsUpstreamServer)(0);
            const httpsUpstreamPort = httpsUpstreamServer.address().port;
            const httpsUpstreamUrl = `https://127.0.0.1:${httpsUpstreamPort}`;

            let stats = null;
            mainProxy = new Server({
                port: 0,
                prepareRequestFunction: () => {
                    return {
                        upstreamProxyUrl: httpsUpstreamUrl,
                        ignoreUpstreamProxyCertificate: true,
                    };
                },
            });

            mainProxy.on('connectionClosed', ({ stats: connectionStats }) => {
                stats = connectionStats;
            });

            await mainProxy.listen();
            const proxyPort = mainProxy.port;

            const result = await requestPromised({
                url: targetUrl,
                proxy: `http://127.0.0.1:${proxyPort}`,
                strictSSL: false,
            });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(stats).to.not.be.null;
            expect(result.body).to.equal('It works!');

            await new Promise(resolve => setTimeout(resolve, 200));

            expect(stats.trgRxBytes).to.be.equal(httpsUpstreamRawTxBytes, `counted trgRxBytes ${stats.trgRxBytes} not equal to actual upstream count ${httpsUpstreamRawTxBytes}`)
            expect(stats.trgTxBytes).to.be.equal(httpsUpstreamRawRxBytes, `counted trgTxBytes ${stats.trgTxBytes} not equal to actual upstream count ${httpsUpstreamRawRxBytes}`)

        } finally {
            if (targetServer) await targetServer.close();
            if (httpsUpstreamServer) await util.promisify(httpsUpstreamServer.close).bind(httpsUpstreamServer)();
            if (mainProxy) await mainProxy.close();
        }
    });
});

const upstreamListener = (clientReq, clientRes) => {
    const hostHeader = clientReq.headers.host;
    if (!hostHeader) {
        clientRes.statusCode = 400;
        clientRes.end('Bad Request: No Host header');
        return;
    }

    const [targetHost, targetPortStr] = hostHeader.split(':');
    const targetPort = targetPortStr ? parseInt(targetPortStr, 10) : 80;

    const options = {
        hostname: targetHost,
        port: targetPort,
        path: clientReq.url,
        method: clientReq.method,
        headers: { ...clientReq.headers },
    };

    delete options.headers['proxy-connection'];
    delete options.headers['proxy-authorization'];

    const targetReq = http.request(options, (targetRes) => {
        clientRes.writeHead(targetRes.statusCode, targetRes.headers);
        targetRes.pipe(clientRes);
    });

    targetReq.on('error', (err) => {
        console.error('Upstream proxy error:', err.message);
        if (!clientRes.headersSent) {
            clientRes.statusCode = 502;
            clientRes.end('Bad Gateway');
        }
    });

    clientReq.pipe(targetReq);
}

