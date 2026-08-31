import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import portastic from 'portastic';
import { createProxy } from 'proxy';
import request from 'request';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Server } from '../../src/index.js';
import { PORT_RANGES } from '../utils/port_ranges.js';
import { TargetServer } from '../utils/target_server.js';
import { closeServer, listenOnPort, takePort } from '../utils/test_helpers.js';

const sslKey = fs.readFileSync(path.join(import.meta.dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(import.meta.dirname, 'ssl.crt'));

describe('HTTP Agent Support', () => {
    let mainProxyServer: Server | undefined;
    let upstreamProxyServer: http.Server | undefined;
    let upstreamProxyPort: number;
    let targetServer: TargetServer;
    let targetServerUrl: string;

    beforeAll(async () => {
        // Get free ports
        const freePorts = await portastic.find(PORT_RANGES.httpAgentHttp);

        // Setup target server
        const targetServerPort = takePort(freePorts);
        targetServer = new TargetServer({
            port: targetServerPort,
            useSsl: false,
        });
        await targetServer.listen();
        targetServerUrl = `http://localhost:${targetServerPort}`;

        // Setup upstream proxy server
        upstreamProxyPort = takePort(freePorts);
        upstreamProxyServer = createProxy(http.createServer());
        await listenOnPort(upstreamProxyServer, upstreamProxyPort);
    });

    afterEach(async () => {
        if (mainProxyServer) await mainProxyServer.close(true);
        mainProxyServer = undefined;
    });

    afterAll(async () => {
        if (targetServer) await targetServer.close();
        if (upstreamProxyServer) await closeServer(upstreamProxyServer);
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
        const mainProxyPort = mainProxyServer.port;

        // Make HTTP request through the proxy
        await new Promise<void>((resolve, reject) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyPort}`,
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
        const mainProxyPort = mainProxyServer.port;

        // Make HTTP request through the proxy
        await new Promise<void>((resolve, reject) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyPort}`,
            }, (error, response) => {
                if (error) return reject(error);
                expect(response.statusCode).toBe(200);
                resolve();
            });
        });
    });

    it('preserves getConnectionStats with agents', async () => {
        const httpAgent = new http.Agent({ keepAlive: true });
        let connectionId: number | undefined;

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
        const mainProxyPort = mainProxyServer.port;

        // Make HTTP request
        await new Promise<void>((resolve, reject) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyPort}`,
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
        if (connectionId === undefined) throw new Error('prepareRequestFunction was never called.');
        const stats = mainProxyServer.getConnectionStats(connectionId);
        expect(stats).toBeTypeOf('object');
        if (stats === undefined) throw new Error(`No stats recorded for connection ${connectionId}.`);
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

        // Setup HTTPS target server on its own port window, so it cannot collide with the http one.
        const httpsFreePorts = await portastic.find(PORT_RANGES.httpAgentHttps);
        const httpsTargetPort = takePort(httpsFreePorts);

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

        // Captured so the closure created in the loop below closes over constants only (`no-loop-func`).
        const mainProxyPort = mainProxyServer.port;

        // Make multiple HTTPS requests through CONNECT tunnel
        for (let i = 0; i < 2; i++) {
            await new Promise<void>((resolve, reject) => {
                request({
                    url: `${httpsTargetUrl}/hello-world`,
                    proxy: `http://localhost:${mainProxyPort}`,
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
        if (upstreamProxyServer) await closeServer(upstreamProxyServer);

        let httpUpstreamConnectionCount = 0;

        // Setup HTTP upstream proxy with connection tracking
        const httpServer = http.createServer();
        httpServer.on('connection', () => {
            httpUpstreamConnectionCount++;
        });

        upstreamProxyServer = createProxy(httpServer);
        await listenOnPort(upstreamProxyServer, upstreamProxyPort);

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

        const targetUrl = targetServerUrl;
        const mainProxyPort = mainProxyServer.port;

        // Make multiple HTTP requests through HTTP upstream proxy
        for (let i = 0; i < 3; i++) {
            await new Promise<void>((resolve, reject) => {
                request({
                    url: `${targetUrl}/hello-world`,
                    proxy: `http://localhost:${mainProxyPort}`,
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
        const mainProxyPort = mainProxyServer.port;

        // Make request - will fail to connect to non-existent HTTPS upstream
        let errorOccurred = false;
        await new Promise<void>((resolve) => {
            request({
                url: `${targetServerUrl}/hello-world`,
                proxy: `http://localhost:${mainProxyPort}`,
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
