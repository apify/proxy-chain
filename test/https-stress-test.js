const fs = require('fs');
const path = require('path');
const tls = require('tls');
const util = require('util');
const request = require('request');
const { expect } = require('chai');
const { Server } = require('../src/index');
const { TargetServer } = require('./utils/target_server');

const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

const requestPromised = util.promisify(request);

describe('HTTPS proxy stress testing', function () {
    this.timeout(60000);

    let server;
    let targetServer;
    let targetServerPort;

    before(async () => {
        targetServer = new TargetServer({ port: 0, useSsl: false });
        await targetServer.listen();
        targetServerPort = targetServer.httpServer.address().port;
    });

    after(async () => {
        if (targetServer) await targetServer.close();
    });

    beforeEach(async () => {
        server = new Server({
            port: 0,
            serverType: 'https',
            httpsOptions: { key: sslKey, cert: sslCrt },
        });
        await server.listen();
    });

    afterEach(async () => {
        if (server) await server.close(true);
    });

    it('handles 100 concurrent HTTP requests with correct responses', async () => {
        const REQUESTS = 100;
        const results = [];

        const promises = [];
        for (let i = 0; i < REQUESTS; i++) {
            promises.push(
                requestPromised({
                    url: `http://127.0.0.1:${targetServerPort}/hello-world`,
                    proxy: `https://127.0.0.1:${server.port}`,
                    strictSSL: false,
                }).then((response) => {
                    results.push({
                        status: response.statusCode,
                        body: response.body,
                    });
                }).catch((err) => {
                    results.push({ error: err.message });
                })
            );
        }

        await Promise.all(promises);

        const successful = results.filter((r) => r.status === 200 && r.body === 'Hello world!');
        expect(successful.length).to.equal(REQUESTS);
    });

    // Not specific for https but still worth to have.
    it('handles 100 concurrent CONNECT tunnels with data verification', async () => {
        const TUNNELS = 100;
        const results = [];

        const promises = [];
        for (let i = 0; i < TUNNELS; i++) {
            promises.push(new Promise((resolve) => {
                const socket = tls.connect({
                    port: server.port,
                    host: '127.0.0.1',
                    rejectUnauthorized: false,
                });

                let requestSent = false;

                socket.on('secureConnect', () => {
                    socket.write(`CONNECT 127.0.0.1:${targetServerPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
                });

                let data = '';
                socket.on('data', (chunk) => {
                    data += chunk.toString();

                    if (data.includes('200 Connection Established') && !requestSent) {
                        requestSent = true;
                        socket.write('GET /hello-world HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
                    }

                    if (data.includes('Hello world')) {
                        socket.destroy();
                        results.push({ success: true });
                        resolve();
                    }
                });

                socket.on('error', (err) => {
                    results.push({ error: err.message });
                    resolve();
                });

                setTimeout(() => {
                    socket.destroy();
                    if (!results.some((r) => r.success || r.error)) {
                        results.push({ error: 'timeout' });
                    }
                    resolve();
                }, 10000);
            }));
        }

        await Promise.all(promises);

        const successful = results.filter((r) => r.success);
        expect(successful.length).to.equal(TUNNELS);
    });

    it('tracks accurate statistics for 100 concurrent requests', async () => {
        const REQUESTS = 100;
        const allStats = [];

        server.on('connectionClosed', ({ stats }) => {
            allStats.push(stats);
        });

        const promises = [];
        for (let i = 0; i < REQUESTS; i++) {
            promises.push(
                requestPromised({
                    url: `http://127.0.0.1:${targetServerPort}/hello-world`,
                    proxy: `https://127.0.0.1:${server.port}`,
                    strictSSL: false,
                })
            );
        }

        await Promise.all(promises);
        await new Promise((r) => setTimeout(r, 500));

        expect(allStats.length).to.equal(REQUESTS);

        allStats.forEach((stats) => {
            // These are application-layer bytes only (no TLS overhead).
            // srcRxBytes > trgTxBytes because hop-by-hop headers (e.g., Proxy-Connection)
            // are stripped when forwarding the request to target.
            expect(stats).to.be.deep.equal({ srcTxBytes: 174, srcRxBytes: 93, trgTxBytes: 71, trgRxBytes: 174 });
        });
    });
});
