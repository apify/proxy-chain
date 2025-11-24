const dns = require('dns');
const fs = require('fs');
const path = require('path');
const portastic = require('portastic');
const { expect } = require('chai');
const { Server } = require('../src/index');
const { TargetServer } = require('./utils/target_server');
const http = require('http');
const net = require('net');

const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

describe('Custom DNS Resolver (dnsLookup)', function () {
    this.timeout(10000);

    let proxyServer;
    let targetServer;
    let upstreamProxyServer;
    let proxyPort;
    let targetPort;
    let upstreamProxyPort;

    let dnsLookupCallCount = 0;
    let lastResolvedHostname = null;

    const createCustomDnsLookup = (resolveToLocalhost = true) => {
        return (hostname, options, callback) => {
            dnsLookupCallCount++;
            lastResolvedHostname = hostname;

            if (hostname === 'custom-resolved.test' && resolveToLocalhost) {
                return callback(null, '127.0.0.1', 4);
            }

            if (hostname === 'dns-error.test') {
                const err = new Error('getaddrinfo ENOTFOUND dns-error.test');
                err.code = 'ENOTFOUND';
                err.hostname = hostname;
                return callback(err);
            }

            if (hostname === 'ipv6-resolved.test') {
                return callback(null, '::1', 6);
            }

            // Fallback to real DNS for localhost and actual target servers
            return dns.lookup(hostname, options, callback);
        };
    };

    beforeEach(async () => {
        dnsLookupCallCount = 0;
        lastResolvedHostname = null;

        const ports = await portastic.find({ min: 50000, max: 51000, retrieve: 3 });
        [proxyPort, targetPort, upstreamProxyPort] = ports;
    });

    afterEach(async () => {
        if (proxyServer) {
            await proxyServer.close(true);
            proxyServer = null;
        }
        if (upstreamProxyServer) {
            await upstreamProxyServer.close(true);
            upstreamProxyServer = null;
        }
        if (targetServer) {
            await targetServer.close();
            targetServer = null;
        }
    });

    it('uses custom dnsLookup for HTTP target through HTTP proxy', async () => {
        targetServer = new TargetServer({ port: targetPort });
        await targetServer.listen();

        proxyServer = new Server({
            port: proxyPort,
            prepareRequestFunction: () => ({
                dnsLookup: createCustomDnsLookup(),
            }),
            verbose: false,
        });
        await proxyServer.listen();

        // Make request through proxy using forward.ts handler
        const response = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost',
                port: proxyPort,
                path: `http://localhost:${targetPort}/test`,
                method: 'GET',
            }, resolve);
            req.on('error', reject);
            req.end();
        });

        expect(response.statusCode).to.equal(200);
        expect(dnsLookupCallCount).to.be.equal(1);
    });

    it('uses custom dnsLookup for CONNECT tunnel through HTTP proxy', async () => {
        targetServer = new TargetServer({ port: targetPort });
        await targetServer.listen();

        proxyServer = new Server({
            port: proxyPort,
            prepareRequestFunction: () => ({
                dnsLookup: createCustomDnsLookup(),
            }),
            verbose: false,
        });
        await proxyServer.listen();

        // Establish CONNECT tunnel using direct.ts handler
        const tunnelEstablished = await new Promise((resolve, reject) => {
            const socket = net.connect({
                host: 'localhost',
                port: proxyPort,
            });

            socket.on('connect', () => {
                socket.write(`CONNECT localhost:${targetPort} HTTP/1.1\r\nHost: localhost:${targetPort}\r\n\r\n`);
            });

            let responseData = '';
            socket.on('data', (data) => {
                responseData += data.toString();
                if (responseData.includes('\r\n\r\n')) {
                    const success = responseData.includes('200 Connection Established');
                    socket.destroy();
                    resolve(success);
                }
            });

            socket.on('error', reject);
        });

        expect(tunnelEstablished).to.equal(true);
        expect(dnsLookupCallCount).to.be.equal(1);
    });

    it('uses custom dnsLookup for CONNECT tunnel through HTTPS proxy', async () => {
        targetServer = new TargetServer({ port: targetPort });
        await targetServer.listen();

        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: sslKey,
                cert: sslCrt,
            },
            prepareRequestFunction: () => ({
                dnsLookup: createCustomDnsLookup(),
            }),
            verbose: false,
        });
        await proxyServer.listen();

        // Establish CONNECT tunnel through HTTPS proxy
        const tls = require('tls');
        const tunnelEstablished = await new Promise((resolve, reject) => {
            const socket = tls.connect({
                host: 'localhost',
                port: proxyPort,
                rejectUnauthorized: false,
            });

            socket.on('secureConnect', () => {
                socket.write(`CONNECT localhost:${targetPort} HTTP/1.1\r\nHost: localhost:${targetPort}\r\n\r\n`);
            });

            let responseData = '';
            socket.on('data', (data) => {
                responseData += data.toString();
                if (responseData.includes('\r\n\r\n')) {
                    const success = responseData.includes('200 Connection Established');
                    socket.destroy();
                    resolve(success);
                }
            });

            socket.on('error', reject);
        });

        expect(tunnelEstablished).to.equal(true);
        expect(dnsLookupCallCount).to.be.equal(1);
    });

    it('handles DNS lookup errors for HTTP requests without upstream (returns 404)', async () => {
        proxyServer = new Server({
            port: proxyPort,
            prepareRequestFunction: () => ({
                dnsLookup: createCustomDnsLookup(),
            }),
            verbose: false,
        });
        await proxyServer.listen();

        // Request to hostname that will fail DNS lookup
        const response = await new Promise((resolve) => {
            const req = http.request({
                hostname: 'localhost',
                port: proxyPort,
                path: 'http://dns-error.test/test',
                method: 'GET',
            }, resolve);
            req.on('error', () => {
                // Ignore connection errors
            });
            req.end();
        });

        // Per statuses.ts:142, forward handler without upstream returns 404 for ENOTFOUND
        expect(response.statusCode).to.equal(404);
        expect(dnsLookupCallCount).to.be.equal(1);
    });

    it('handles DNS lookup errors when resolving upstream proxy hostname (returns 593)', async () => {
        proxyServer = new Server({
            port: proxyPort,
            prepareRequestFunction: () => ({
                // Upstream proxy hostname that will fail DNS resolution
                upstreamProxyUrl: 'http://dns-error.test:8080',
                dnsLookup: createCustomDnsLookup(),
            }),
            verbose: false,
        });
        await proxyServer.listen();

        const response = await new Promise((resolve) => {
            const req = http.request({
                hostname: 'localhost',
                port: proxyPort,
                path: 'http://example.com/test',
                method: 'GET',
            }, resolve);
            req.on('error', () => {
                // Ignore errors
            });
            req.end();
        });

        // DNS error when connecting to upstream proxy returns 593
        expect(response.statusCode).to.equal(593);
        expect(dnsLookupCallCount).to.be.equal(1);
    });

    it('handles DNS errors in CONNECT tunnels (connection fails)', async () => {
        proxyServer = new Server({
            port: proxyPort,
            prepareRequestFunction: () => ({
                dnsLookup: createCustomDnsLookup(),
            }),
            verbose: false,
        });
        await proxyServer.listen();

        // Try to establish CONNECT tunnel to host with DNS error
        const connectionFailed = await new Promise((resolve) => {
            const socket = net.connect({
                host: 'localhost',
                port: proxyPort,
            });

            socket.on('connect', () => {
                socket.write('CONNECT dns-error.test:443 HTTP/1.1\r\nHost: dns-error.test:443\r\n\r\n');
            });

            let responseData = '';
            socket.on('data', (data) => {
                responseData += data.toString();
                if (responseData.includes('\r\n\r\n')) {
                    const isError = !responseData.includes('200 Connection Established');
                    socket.destroy();
                    resolve(isError);
                }
            });

            socket.on('error', () => {
                resolve(true); // Connection failed as expected
            });

            socket.on('close', () => {
                if (!responseData) {
                    resolve(true); // Connection closed without response
                }
            });

            // Timeout if no response
            setTimeout(() => {
                socket.destroy();
                resolve(true);
            }, 3000);
        });

        expect(connectionFailed).to.equal(true);
        expect(dnsLookupCallCount).to.be.equal(1);
    });

    it('uses custom DNS with upstream proxy chaining', async () => {
        targetServer = new TargetServer({ port: targetPort });
        await targetServer.listen();

        upstreamProxyServer = new Server({
            port: upstreamProxyPort,
            verbose: false,
        });
        await upstreamProxyServer.listen();

        // Main proxy with custom DNS that chains to upstream (uses chain.ts)
        proxyServer = new Server({
            port: proxyPort,
            prepareRequestFunction: () => ({
                upstreamProxyUrl: `http://localhost:${upstreamProxyPort}`,
                dnsLookup: createCustomDnsLookup(),
            }),
            verbose: false,
        });
        await proxyServer.listen();

        const response = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost',
                port: proxyPort,
                path: `http://localhost:${targetPort}/test`,
                method: 'GET',
            }, resolve);
            req.on('error', reject);
            req.end();
        });

        expect(response.statusCode).to.equal(200);
        expect(dnsLookupCallCount).to.be.equal(1);
    });

    it('resolves IPv6 addresses correctly', async () => {
        targetServer = new TargetServer({ port: targetPort });
        await targetServer.listen();

        let resolvedFamily = null;

        const ipv6DnsLookup = (hostname, options, callback) => {
            dnsLookupCallCount++;

            if (hostname === 'ipv6-resolved.test') {
                resolvedFamily = 6;
                return callback(null, '::1', 6);
            }

            // For localhost, use IPv4
            return dns.lookup(hostname, options, callback);
        };

        proxyServer = new Server({
            port: proxyPort,
            prepareRequestFunction: () => ({
                dnsLookup: ipv6DnsLookup,
            }),
            verbose: false,
        });
        await proxyServer.listen();

        // Make a request that triggers IPv6 resolution
        try {
            await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: 'localhost',
                    port: proxyPort,
                    path: 'http://ipv6-resolved.test/test',
                    method: 'GET',
                    timeout: 2000,
                }, resolve);
                req.on('error', reject);
                req.end();
            });
        } catch (error) {
            // Expected to fail, but DNS lookup should have been called
        }

        expect(dnsLookupCallCount).to.be.equal(1);
        expect(resolvedFamily).to.equal(6);
    });

    it('verifies custom DNS function is actually called', async () => {
        targetServer = new TargetServer({ port: targetPort });
        await targetServer.listen();

        let customDnsCalled = false;
        const verifiableDnsLookup = (hostname, options, callback) => {
            customDnsCalled = true;
            dnsLookupCallCount++;
            return dns.lookup(hostname, options, callback);
        };

        proxyServer = new Server({
            port: proxyPort,
            prepareRequestFunction: () => ({
                dnsLookup: verifiableDnsLookup,
            }),
            verbose: false,
        });
        await proxyServer.listen();

        const response = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost',
                port: proxyPort,
                path: `http://localhost:${targetPort}/test`,
                method: 'GET',
            }, resolve);
            req.on('error', reject);
            req.end();
        });

        expect(response.statusCode).to.equal(200);
        expect(customDnsCalled).to.equal(true);
        expect(dnsLookupCallCount).to.be.equal(1);
    });
});
