import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import portastic from 'portastic';
import { createProxy } from 'proxy';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Server } from '../../src/index.js';
import { createDispatcher, httpRequest } from '../utils/http_client.js';
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
        const response = await httpRequest({
            url: `${targetServerUrl}/hello-world`,
            proxyUrl: `http://localhost:${mainProxyPort}`,
        });
        expect(response.statusCode).toBe(200);

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
        const response = await httpRequest({
            url: `${targetServerUrl}/hello-world`,
            proxyUrl: `http://localhost:${mainProxyPort}`,
        });
        expect(response.statusCode).toBe(200);
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

        // Keep the dispatcher open so the socket outlives the request.
        const requestOpts = {
            url: `${targetServerUrl}/hello-world`,
            proxyUrl: `http://localhost:${mainProxyPort}`,
        };
        const dispatcher = createDispatcher(requestOpts);

        try {
            const response = await httpRequest({ ...requestOpts, dispatcher });
            expect(response.statusCode).toBe(200);

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
        } finally {
            await dispatcher.close();
            httpAgent.destroy();
        }
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
            const response = await httpRequest({
                url: `${httpsTargetUrl}/hello-world`,
                proxyUrl: `http://localhost:${mainProxyPort}`,
                ignoreCertificateErrors: true, // Allow self-signed cert
            });
            expect(response.statusCode).toBe(200);
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
            const response = await httpRequest({
                url: `${targetUrl}/hello-world`,
                proxyUrl: `http://localhost:${mainProxyPort}`,
            });
            expect(response.statusCode).toBe(200);
        }

        // Verify httpAgent pools connections to HTTP upstream (1 connection for 3 requests)
        expect(httpUpstreamConnectionCount, 'httpAgent should pool connections to HTTP upstream').toBe(1);

        httpAgent.destroy();
    });

    describe('with HTTPS upstream proxy', () => {
        // A real HTTPS upstream proxy: proxy-chain itself running with `serverType: 'https'`.
        let httpsUpstreamProxy: Server | undefined;
        let upstreamConnectionIds: Set<number>;
        let upstreamRequestCount: number;

        const startHttpsUpstreamProxy = async (): Promise<string> => {
            upstreamConnectionIds = new Set();
            upstreamRequestCount = 0;

            httpsUpstreamProxy = new Server({
                port: 0,
                serverType: 'https',
                httpsOptions: { key: sslKey, cert: sslCrt },
                prepareRequestFunction: ({ connectionId }) => {
                    upstreamConnectionIds.add(connectionId);
                    upstreamRequestCount++;
                    return {};
                },
            });
            await httpsUpstreamProxy.listen();

            return `https://localhost:${httpsUpstreamProxy.port}`;
        };

        const startMainProxy = async (upstreamProxyUrl: string, httpsAgent: https.Agent): Promise<string> => {
            mainProxyServer = new Server({
                port: 0,
                prepareRequestFunction: () => ({
                    upstreamProxyUrl,
                    // The upstream uses a self-signed certificate.
                    ignoreUpstreamProxyCertificate: true,
                    httpsAgent,
                }),
            });
            await mainProxyServer.listen();

            return `http://localhost:${mainProxyServer.port}`;
        };

        afterEach(async () => {
            if (httpsUpstreamProxy) await httpsUpstreamProxy.close(true);
            httpsUpstreamProxy = undefined;
        });

        it('pools connections to the upstream in forward mode', async () => {
            const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
            const createConnection = vi.spyOn(httpsAgent, 'createConnection');

            try {
                const proxyUrl = await startMainProxy(await startHttpsUpstreamProxy(), httpsAgent);

                for (let i = 0; i < 3; i++) {
                    const response = await httpRequest({ url: `${targetServerUrl}/hello-world`, proxyUrl });
                    expect(response.statusCode).toBe(200);
                    expect(response.body).toBe('Hello world!');
                }

                expect(upstreamRequestCount).toBe(3);
                expect(upstreamConnectionIds.size, 'httpsAgent should reuse one TLS connection to the upstream').toBe(1);
                expect(createConnection).toHaveBeenCalledTimes(1);
            } finally {
                httpsAgent.destroy();
            }
        });

        it('opens a new upstream connection per request when keepAlive is off', async () => {
            const httpsAgent = new https.Agent({ keepAlive: false });
            const createConnection = vi.spyOn(httpsAgent, 'createConnection');

            try {
                const proxyUrl = await startMainProxy(await startHttpsUpstreamProxy(), httpsAgent);

                for (let i = 0; i < 3; i++) {
                    const response = await httpRequest({ url: `${targetServerUrl}/hello-world`, proxyUrl });
                    expect(response.statusCode).toBe(200);
                }

                // Proves the server uses the agent from `prepareRequestFunction`, not https.globalAgent.
                expect(upstreamConnectionIds.size).toBe(3);
                expect(createConnection).toHaveBeenCalledTimes(3);
            } finally {
                httpsAgent.destroy();
            }
        });

        it('tunnels HTTPS targets through the upstream in chain mode', async () => {
            const httpsTargetPort = takePort(await portastic.find(PORT_RANGES.httpAgentHttps));
            const httpsTarget = new TargetServer({ port: httpsTargetPort, useSsl: true, sslKey, sslCrt });
            await httpsTarget.listen();

            const httpsAgent = new https.Agent({ keepAlive: true });
            const createConnection = vi.spyOn(httpsAgent, 'createConnection');

            try {
                const proxyUrl = await startMainProxy(await startHttpsUpstreamProxy(), httpsAgent);

                for (let i = 0; i < 2; i++) {
                    const response = await httpRequest({
                        url: `https://localhost:${httpsTargetPort}/hello-world`,
                        proxyUrl,
                        ignoreCertificateErrors: true,
                    });
                    expect(response.statusCode).toBe(200);
                    expect(response.body).toBe('Hello world!');
                }

                expect(upstreamRequestCount).toBe(2);
                // Node.js removes a socket from the agent once it carries a CONNECT tunnel,
                // so every tunnel gets its own upstream connection even with keepAlive on.
                expect(upstreamConnectionIds.size).toBe(2);
                expect(createConnection).toHaveBeenCalledTimes(2);
                expect(Object.keys(httpsAgent.freeSockets)).toHaveLength(0);
            } finally {
                httpsAgent.destroy();
                await httpsTarget.close();
            }
        });
    });
});
