const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { expect } = require('chai');
const portastic = require('portastic');
const proxy = require('proxy');
const request = require('request');

const { Server } = require('../src/index');
const { TargetServer } = require('./utils/target_server');

const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

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
        if (upstreamProxyServer) upstreamProxyServer.close();

        // Track connections at upstream proxy to verify pooling behavior
        let upstreamConnectionCount = 0;

        // Recreate upstream proxy with connection tracking
        await new Promise((resolve, reject) => {
            const httpServer = http.createServer();
            httpServer.on('connection', () => {
                upstreamConnectionCount++;
            });

            upstreamProxyServer = proxy(httpServer);
            upstreamProxyServer.listen(upstreamProxyPort, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 1,
        });

        let requestCount = 0;

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
        // Verify connection pooling: fewer connections than requests
        expect(upstreamConnectionCount).to.be.eql(1, 'Connection pooling should reuse connections');

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
                forever: true, // Keep socket alive
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).to.eql(200);

                // Keep the connection alive briefly to check stats
                setImmediate(() => resolve());
            });
        });

        // Verify getConnectionStats works while connection may still be open
        expect(connectionId).to.be.a('number');
        const stats = mainProxyServer.getConnectionStats(connectionId);
        expect(stats).to.be.an('object');
        expect(stats.srcTxBytes).to.be.a('number');
        expect(stats.srcTxBytes).to.be.greaterThan(0);
        expect(stats.srcRxBytes).to.be.a('number');
        expect(stats.srcRxBytes).to.be.greaterThan(0);
        expect(stats.trgTxBytes).to.be.a('number');
        expect(stats.trgTxBytes).to.be.greaterThan(0);
        expect(stats.trgRxBytes).to.be.a('number');
        expect(stats.trgRxBytes).to.be.greaterThan(0);

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

    it('works with HTTPS targets using CONNECT tunneling', async () => {
        if (mainProxyServer) await mainProxyServer.close(true);

        // Close existing HTTP target server
        const originalTargetServer = targetServer;
        const originalTargetServerUrl = targetServerUrl;
        await targetServer.close();

        // Setup HTTPS target server on new port. Use different range to avoid conflicts with http server
        const httpsFreePorts = await portastic.find({ min: 50100, max: 50200 });
        const httpsTargetPort = httpsFreePorts.shift();

        targetServer = new TargetServer({
            port: httpsTargetPort,
            useSsl: true,
            sslKey,
            sslCrt,
        });
        await targetServer.listen();
        const httpsTargetUrl = `https://localhost:${httpsTargetPort}`;

        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 1,
        });

        let requestCount = 0;

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

        // Make multiple HTTPS requests through CONNECT tunnel
        for (let i = 0; i < 2; i++) {
            await new Promise((resolve, reject) => {
                request({
                    url: `${httpsTargetUrl}/hello-world`,
                    proxy: `http://localhost:${mainProxyServerPort}`,
                    strictSSL: false, // Allow self-signed cert
                }, (error, response) => {
                    if (error) return reject(error);
                    expect(response.statusCode).to.eql(200);
                    resolve();
                });
            });
        }

        // Verify both requests were handled
        expect(requestCount).to.eql(2);

        httpAgent.destroy();

        // Restore original HTTP target server
        await targetServer.close();
        targetServer = originalTargetServer;
        targetServerUrl = originalTargetServerUrl;
        await targetServer.listen();
    });

    it('uses httpsAgent with HTTPS upstream proxy', async () => {
        if (mainProxyServer) await mainProxyServer.close(true);

        const httpAgent = new http.Agent({ keepAlive: true });
        const httpsAgent = new https.Agent({ keepAlive: true });

        let httpAgentUsed = false;
        let httpsAgentUsed = false;

        // Track which agent's createConnection is called
        const originalHttpCreateConnection = httpAgent.createConnection;
        httpAgent.createConnection = function(...args) {
            httpAgentUsed = true;
            return originalHttpCreateConnection.apply(this, args);
        };

        const originalHttpsCreateConnection = httpsAgent.createConnection;
        httpsAgent.createConnection = function(...args) {
            httpsAgentUsed = true;
            return originalHttpsCreateConnection.apply(this, args);
        };

        mainProxyServer = new Server({
            port: mainProxyServerPort,
            prepareRequestFunction: () => {
                return {
                    // Use HTTP upstream but pretend it's HTTPS to test agent selection
                    // The protocol in the URL determines which agent is used
                    upstreamProxyUrl: `https://localhost:${upstreamProxyPort}`,
                    ignoreUpstreamProxyCertificate: true,
                    httpAgent,
                    httpsAgent,
                };
            },
        });

        await mainProxyServer.listen();

        // Make HTTP request - will likely fail due to protocol mismatch, but agent selection will occur
        await new Promise((resolve) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyServerPort}`,
                timeout: 1000,
            }, () => {
                // Ignore result - we're verifying agent selection behavior
                resolve();
            });
        });

        // Wait for agent usage
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify httpsAgent was used (not httpAgent) because upstream URL uses https://
        expect(httpsAgentUsed).to.be.true;
        expect(httpAgentUsed).to.be.false;

        httpAgent.destroy();
        httpsAgent.destroy();
    });
});
