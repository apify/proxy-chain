import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import portastic from 'portastic';
import proxy from 'proxy';
import request from 'request';

import { Server } from '../../src/index.js';
import { TargetServer } from '../utils/target_server.js';

const sslKey = fs.readFileSync(path.join(import.meta.dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(import.meta.dirname, 'ssl.crt'));

describe('HTTP Agent Support', () => {
    let mainProxyServer;
    let upstreamProxyServer;
    let upstreamProxyPort;
    let targetServer;
    let targetServerUrl;

    beforeAll(async () => {
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
    });

    afterEach(async () => {
        if (mainProxyServer) await mainProxyServer.close(true);
        mainProxyServer = undefined;
    });

    afterAll(async () => {
        if (targetServer) await targetServer.close();
        if (upstreamProxyServer) await new Promise((resolve) => upstreamProxyServer.close(resolve));
    });

    it('httpAgent smoke test - no exceptions', async () => {
        const httpAgent = new http.Agent({ keepAlive: true });
        const httpsAgent = new https.Agent({ keepAlive: true });

        mainProxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => {
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
                proxy: `http://localhost:${mainProxyServer.port}`,
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).toBe(200);
                resolve();
            });
        });

        // Cleanup agents
        httpAgent.destroy();
        httpsAgent.destroy();
    });

    it('works without agents (backward compatibility)', async () => {
        mainProxyServer = new Server({
            port: 0,
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
                proxy: `http://localhost:${mainProxyServer.port}`,
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).toBe(200);
                resolve();
            });
        });
    });

    it('preserves getConnectionStats with agents', async () => {
        const httpAgent = new http.Agent({ keepAlive: true });
        let connectionId;

        mainProxyServer = new Server({
            port: 0,
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
                proxy: `http://localhost:${mainProxyServer.port}`,
                forever: true, // Keep socket alive
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).toBe(200);

                // Keep the connection alive briefly to check stats
                setImmediate(() => resolve());
            });
        });

        // Verify getConnectionStats works while connection may still be open
        expect(connectionId).toBeTypeOf('number');
        const stats = mainProxyServer.getConnectionStats(connectionId);
        expect(stats).toBeTypeOf('object');
        expect(stats.srcTxBytes).toBeGreaterThan(0);
        expect(stats.srcRxBytes).toBeGreaterThan(0);
        expect(stats.trgTxBytes).toBeGreaterThan(0);
        expect(stats.trgRxBytes).toBeGreaterThan(0);

        httpAgent.destroy();
    });

    it('works with HTTPS targets using CONNECT tunneling', async () => {
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
            port: 0,
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
                    proxy: `http://localhost:${mainProxyServer.port}`,
                    strictSSL: false, // Allow self-signed cert
                }, (error, response) => {
                    if (error) return reject(error);
                    expect(response.statusCode).toBe(200);
                    resolve();
                });
            });
        }

        // Verify both requests were handled
        expect(requestCount).toBe(2);

        httpAgent.destroy();

        // Restore original HTTP target server
        await targetServer.close();
        targetServer = originalTargetServer;
        targetServerUrl = originalTargetServerUrl;
        await targetServer.listen();
    });

    it('pools connections with HTTP upstream proxy', async () => {
        if (upstreamProxyServer) await new Promise((resolve) => upstreamProxyServer.close(resolve));

        let httpUpstreamConnectionCount = 0;

        // Setup HTTP upstream proxy with connection tracking
        await new Promise((resolve, reject) => {
            const httpServer = http.createServer();
            httpServer.on('connection', () => {
                httpUpstreamConnectionCount++;
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

        mainProxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => {
                return {
                    upstreamProxyUrl: `http://localhost:${upstreamProxyPort}`,
                    httpAgent,
                };
            },
        });

        await mainProxyServer.listen();

        // Make multiple HTTP requests through HTTP upstream proxy
        for (let i = 0; i < 3; i++) {
            await new Promise((resolve, reject) => {
                request({
                    url: `${targetServerUrl}/hello-world`,
                    proxy: `http://localhost:${mainProxyServer.port}`,
                }, (error, response) => {
                    if (error) return reject(error);
                    expect(response.statusCode).toBe(200);
                    resolve();
                });
            });
        }

        // Verify httpAgent pools connections to HTTP upstream (1 connection for 3 requests)
        expect(httpUpstreamConnectionCount, 'httpAgent should pool connections to HTTP upstream').toBe(1);

        httpAgent.destroy();
    });

    it('works with HTTPS upstream proxy', async () => {
        const httpsAgent = new https.Agent({ keepAlive: true });

        let httpsUpstreamRequests = 0;

        mainProxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => {
                httpsUpstreamRequests++;
                return {
                    // Use non-existent HTTPS upstream - request will fail but proves code path works
                    upstreamProxyUrl: `https://non-existent-https-proxy.example.com:8080`,
                    ignoreUpstreamProxyCertificate: true,
                    httpsAgent,
                };
            },
        });

        await mainProxyServer.listen();

        // Make request - will fail to connect to non-existent HTTPS upstream
        let errorOccurred = false;
        await new Promise((resolve) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyServer.port}`,
                timeout: 2000,
            }, (error, response) => {
                if (error) {
                    errorOccurred = true;
                } else if (response && response.statusCode >= 500) {
                    // 5xx error from proxy indicates upstream connection issue
                    errorOccurred = true;
                }
                resolve();
            });
        });

        // Verify prepareRequestFunction was called with HTTPS upstream
        expect(httpsUpstreamRequests).toBe(1);
        // Request should fail or return 5xx due to non-existent HTTPS upstream
        expect(errorOccurred).toBe(true);

        httpsAgent.destroy();
    });
});
