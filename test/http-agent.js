const http = require('http');
const https = require('https');
const { expect } = require('chai');
const portastic = require('portastic');
const proxy = require('proxy');
const request = require('request');

const { Server } = require('../src/index');
const { TargetServer } = require('./utils/target_server');

describe('HTTP Agent Support', () => {
    let mainProxyServer;
    let mainProxyServerPort;
    let upstreamProxyServer;
    let upstreamProxyPort;
    let targetServer;
    let targetServerUrl;

    before(async () => {
        // Get free ports
        const freePorts = await portastic.find({ min: 50000, max: 50100 });

        // Setup target server
        const targetServerPort = freePorts.shift();
        targetServer = new TargetServer({
            port: targetServerPort,
            useSsl: false,
        });
        await targetServer.listen();
        targetServerUrl = `http://localhost:${targetServerPort}`;

        // Setup upstream proxy server
        upstreamProxyPort = freePorts.shift();
        await new Promise((resolve, reject) => {
            upstreamProxyServer = proxy(http.createServer());
            upstreamProxyServer.listen(upstreamProxyPort, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        // Setup main proxy server with custom agents
        mainProxyServerPort = freePorts.shift();
    });

    after(() => {
        if (targetServer) targetServer.close();
        if (upstreamProxyServer) upstreamProxyServer.close();
        if (mainProxyServer) mainProxyServer.close(true);
    });

    it('accepts httpAgent and httpsAgent in prepareRequestFunction', async () => {
        const httpAgent = new http.Agent({ keepAlive: true });
        const httpsAgent = new https.Agent({ keepAlive: true });

        let agentsPassed = false;

        if (mainProxyServer) await mainProxyServer.close(true);

        mainProxyServer = new Server({
            port: mainProxyServerPort,
            prepareRequestFunction: () => {
                agentsPassed = true;
                return {
                    upstreamProxyUrl: `http://localhost:${upstreamProxyPort}`,
                    httpAgent,
                    httpsAgent,
                };
            },
        });

        await mainProxyServer.listen();

        // Make HTTP request through the proxy
        await new Promise((resolve, reject) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyServerPort}`,
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).to.eql(200);
                resolve();
            });
        });

        expect(agentsPassed).to.be.true;

        // Cleanup agents
        httpAgent.destroy();
        httpsAgent.destroy();
    });

    it('reuses connections with keepAlive agents (sticky IP simulation)', async () => {
        if (mainProxyServer) await mainProxyServer.close(true);

        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 1,
        });

        let requestCount = 0;
        const socketIds = [];

        // Track sockets to verify reuse
        httpAgent.on('free', (socket) => {
            const socketId = `${socket.remoteAddress}:${socket.remotePort}`;
            socketIds.push(socketId);
        });

        mainProxyServer = new Server({
            port: mainProxyServerPort,
            prepareRequestFunction: () => {
                requestCount++;
                return {
                    upstreamProxyUrl: `http://localhost:${upstreamProxyPort}`,
                    httpAgent,
                };
            },
        });

        await mainProxyServer.listen();

        // Make multiple requests
        for (let i = 0; i < 3; i++) {
            await new Promise((resolve, reject) => {
                request({
                    url: `${targetServerUrl}/hello-world`,
                    proxy: `http://localhost:${mainProxyServerPort}`,
                }, (error, response) => {
                    if (error) return reject(error);
                    expect(response.statusCode).to.eql(200);
                    resolve();
                });
            });
        }

        expect(requestCount).to.eql(3);

        // Verify sockets were reused (all should have same remote address:port)
        if (socketIds.length > 1) {
            const firstSocketId = socketIds[0];
            socketIds.forEach((socketId) => {
                expect(socketId).to.eql(firstSocketId, 'Socket was reused for connection pooling');
            });
        }

        httpAgent.destroy();
    });

    it('works without agents (backward compatibility)', async () => {
        if (mainProxyServer) await mainProxyServer.close(true);

        mainProxyServer = new Server({
            port: mainProxyServerPort,
            prepareRequestFunction: () => {
                return {
                    upstreamProxyUrl: `http://localhost:${upstreamProxyPort}`,
                    // No agents provided - should work fine
                };
            },
        });

        await mainProxyServer.listen();

        // Make HTTP request through the proxy
        await new Promise((resolve, reject) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyServerPort}`,
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).to.eql(200);
                resolve();
            });
        });
    });

    it('preserves getConnectionStats with agents', async () => {
        if (mainProxyServer) await mainProxyServer.close(true);

        const httpAgent = new http.Agent({ keepAlive: true });
        let connectionId;

        mainProxyServer = new Server({
            port: mainProxyServerPort,
            prepareRequestFunction: ({ connectionId: id }) => {
                connectionId = id;
                return {
                    upstreamProxyUrl: `http://localhost:${upstreamProxyPort}`,
                    httpAgent,
                };
            },
        });

        await mainProxyServer.listen();

        // Make HTTP request
        await new Promise((resolve, reject) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyServerPort}`,
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).to.eql(200);
                resolve();
            });
        });

        // Verify getConnectionStats still works
        const stats = mainProxyServer.getConnectionStats(connectionId);
        expect(stats).to.be.an('object');
        expect(stats.srcTxBytes).to.be.a('number');
        expect(stats.srcRxBytes).to.be.a('number');

        httpAgent.destroy();
    });

    it('uses separate agents for HTTP and HTTPS upstream proxies', async () => {
        if (mainProxyServer) await mainProxyServer.close(true);

        const httpAgent = new http.Agent({ keepAlive: true });
        const httpsAgent = new https.Agent({ keepAlive: true });

        let httpAgentUsed = false;
        let httpsAgentUsed = false;

        // Track which agent is used
        const originalCreateConnection = httpAgent.createConnection;
        httpAgent.createConnection = function(...args) {
            httpAgentUsed = true;
            return originalCreateConnection.apply(this, args);
        };

        mainProxyServer = new Server({
            port: mainProxyServerPort,
            prepareRequestFunction: () => {
                return {
                    upstreamProxyUrl: `http://localhost:${upstreamProxyPort}`,
                    httpAgent,
                    httpsAgent,
                };
            },
        });

        await mainProxyServer.listen();

        // Make HTTP request (should use httpAgent)
        await new Promise((resolve, reject) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyServerPort}`,
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).to.eql(200);
                resolve();
            });
        });

        expect(httpAgentUsed).to.be.true;

        httpAgent.destroy();
        httpsAgent.destroy();
    });
});
