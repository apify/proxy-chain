import http from 'node:http';
import type net from 'node:net';

import basicAuthParser from 'basic-auth-parser';
import express from 'express';
import portastic from 'portastic';
import { createProxy, type ProxyServer } from 'proxy';
import _ from 'underscore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { anonymizeProxy, closeAnonymizedProxy, listenConnectAnonymizedProxy } from '../../src/index.js';
import { expectSuccessfulRequest } from '../utils/http_assertions.js';
import { httpRequest } from '../utils/http_client.js';
import { PORT_RANGES } from '../utils/port_ranges.js';
import { closeServer, getServerPort, listenOnPort } from '../utils/test_helpers.js';

let expressServer: http.Server | undefined;
let proxyServer: http.Server | undefined;
let proxyPort: number;
let testServerPort: number;
const proxyAuth = { scheme: 'Basic', username: 'username', password: 'password' };
let wasProxyCalled = false;

// Setup local proxy server and web server for the tests
beforeAll(async () => {
    // Find free port for the proxy
    let freePorts: number[];
    return portastic.find(PORT_RANGES.anonymizeProxy)
        .then(async (result) => {
            freePorts = result;
            return new Promise<void>((resolve, reject) => {
                const httpServer: ProxyServer = http.createServer();

                // Setup proxy authorization
                httpServer.authenticate = function (req) {
                    // parse the "Proxy-Authorization" header
                    const auth = req.headers['proxy-authorization'];
                    if (!auth) return false;

                    const parsed = basicAuthParser(auth);
                    const isEqual = _.isEqual(parsed, proxyAuth);
                    if (isEqual) wasProxyCalled = true;
                    return isEqual;
                };

                httpServer.on('error', reject);

                const server = createProxy(httpServer);
                proxyServer = server;
                server.listen(freePorts[0], () => {
                    proxyPort = getServerPort(server);
                    resolve();
                });
            });
        })
        .then(async () => {
            const app = express();

            app.get('/', (_req, res) => res.send('Hello World!'));

            testServerPort = freePorts[1];
            return new Promise<void>((resolve) => {
                expressServer = app.listen(testServerPort, () => {
                    resolve();
                });
            });
        });
});

afterAll(async () => {
    if (expressServer) await closeServer(expressServer);

    if (proxyServer) await closeServer(proxyServer);
}, 5_000);

describe('utils.anonymizeProxy', { timeout: 5_000 }, () => {
    it('throws for invalid args', async () => {
        // @ts-expect-error - deliberately passing null instead of a URL or options object.
        await expect(anonymizeProxy(null)).rejects.toThrow();
        // @ts-expect-error - deliberately passing no arguments at all.
        await expect(anonymizeProxy()).rejects.toThrow();
        // @ts-expect-error - deliberately passing an options object without a url.
        await expect(anonymizeProxy({})).rejects.toThrow();

        // @ts-expect-error - deliberately passing an object instead of a URL string.
        await expect(closeAnonymizedProxy({})).rejects.toThrow();
        // @ts-expect-error - deliberately passing no arguments at all.
        await expect(closeAnonymizedProxy()).rejects.toThrow();
        // @ts-expect-error - deliberately passing null instead of a URL string.
        await expect(closeAnonymizedProxy(null)).rejects.toThrow();
    });

    it('keeps a credential-less https: proxy as is', async () => {
        expect(await anonymizeProxy('https://whatever.com')).toBe('https://whatever.com');
        expect(await anonymizeProxy({ url: 'https://whatever.com' })).toBe('https://whatever.com');
    });

    it('throws for invalid ports', async () => {
        await expect(anonymizeProxy({ url: 'http://whatever.com', port: -16 })).rejects.toThrow();
        await expect(anonymizeProxy({ url: 'http://whatever.com', port: 4324324324 })).rejects.toThrow();
    });

    it('throws for invalid URLs', async () => {
        await expect(anonymizeProxy('://whatever.com')).rejects.toThrow();
        await expect(anonymizeProxy({ url: '://whatever.com' })).rejects.toThrow();
    });

    it('keeps already anonymous proxies', async () => {
        const anonymousProxyUrl = await anonymizeProxy('http://whatever:4567');
        expect(anonymousProxyUrl).toBe('http://whatever:4567');

        const anonymousProxyUrl2 = await anonymizeProxy('http://whatever:4567');
        expect(anonymousProxyUrl2).toBe('http://whatever:4567');
    });

    it('anonymizes authenticated upstream proxy', async () => {
        const [proxyUrl1, proxyUrl2] = await Promise.all([
            anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
            anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
        ]);

        expect(proxyUrl1).not.toContain(`${proxyPort}`);
        expect(proxyUrl2).not.toContain(`${proxyPort}`);
        expect(proxyUrl1).not.toBe(proxyUrl2);

        // Test call through proxy 1
        wasProxyCalled = false;
        await expectSuccessfulRequest({
            url: `http://localhost:${testServerPort}`,
            proxyUrl: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        // Test call through proxy 2
        wasProxyCalled = false;
        await expectSuccessfulRequest({
            url: `http://localhost:${testServerPort}`,
            proxyUrl: proxyUrl2,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        // Test again call through proxy 1
        wasProxyCalled = false;
        await expectSuccessfulRequest({
            url: `http://localhost:${testServerPort}`,
            proxyUrl: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        // Close proxy 1 and verify
        const closed1 = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1).toBe(true);

        // Test proxy is really closed. Node.js 20+ may report 'socket hang up'
        // instead of 'ECONNREFUSED'.
        await expect(httpRequest({ url: proxyUrl1 })).rejects.toThrow(/ECONNREFUSED|socket hang up/);

        // Close proxy 2
        const closed2 = await closeAnonymizedProxy(proxyUrl2, true);
        expect(closed2).toBe(true);

        // Test the second-time call to close (should return false)
        const closed1Again = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1Again).toBe(false);

        // Test another second-time call to close
        const closed2Again = await closeAnonymizedProxy(proxyUrl2, false);
        expect(closed2Again).toBe(false);
    });

    it('handles many concurrent calls without port collision', async () => {
        const N = 20;
        let proxyUrls: string[];

        return Promise.resolve()
            .then(async () => {
                const promises = [];
                for (let i = 0; i < N; i++) {
                    promises.push(anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`));
                }

                return Promise.all(promises);
            })
            .then(async (results) => {
                const promises = [];
                proxyUrls = results;
                for (let i = 0; i < N; i++) {
                    expect(proxyUrls[i]).not.toContain(`${proxyPort}`);

                    // Test call through proxy
                    promises.push(expectSuccessfulRequest({
                        url: `http://localhost:${testServerPort}`,
                        proxyUrl: proxyUrls[i],
                        expectBodyContainsText: 'Hello World!',
                    }));
                }

                return Promise.all(promises);
            })
            .then(async () => {
                expect(wasProxyCalled).toBe(true);
                const promises = [];

                for (let i = 0; i < N; i++) {
                    promises.push(closeAnonymizedProxy(proxyUrls[i], true));
                }

                return Promise.all(promises);
            })
            .then((results) => {
                for (let i = 0; i < N; i++) {
                    expect(results[i]).toBe(true);
                }
            });
    });

    it('handles HTTP CONNECT request properly', { timeout: 50_000 }, async () => {
        const host = `localhost:${testServerPort}`;
        let onconnectArgs: http.IncomingMessage | undefined;
        function onconnect(message: http.IncomingMessage, socket: net.Socket) {
            onconnectArgs = message;
            socket.write('HTTP/1.1 401 UNAUTHORIZED\r\n\r\n');
            socket.end();
            socket.destroy();
        }

        const localProxy = http.createServer();
        localProxy.on('connect', onconnect);

        let proxyUrl: string;

        return listenOnPort(localProxy, 0)
            .then(async () => anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${getServerPort(localProxy)}`))
            .then(async (url) => {
                proxyUrl = url;

                return httpRequest({
                    url: `https://${host}`,
                    proxyUrl,
                });
            })
            .then(() => {
                expect.unreachable();
            }, () => {
                if (onconnectArgs === undefined) throw new Error('The local proxy never received a CONNECT request.');
                expect(onconnectArgs.headers.host).toBe(host);
                expect(onconnectArgs.url).toBe(host);
            })
            .finally(async () => closeAnonymizedProxy(proxyUrl, true))
            .finally(() => localProxy.close());
    });

    it('handles HTTP CONNECT callback properly', { timeout: 50_000 }, async () => {
        const host = `localhost:${testServerPort}`;
        let rawHeadersRetrieved: string[] | undefined;
        function onconnect(_message: http.IncomingMessage, socket: net.Socket) {
            socket.write('HTTP/1.1 200 OK\r\nfoo: bar\r\n\r\n');
            socket.end();
            socket.destroy();
        }

        let proxyUrl: string;

        const localProxy = http.createServer();
        localProxy.on('connect', onconnect);

        return listenOnPort(localProxy, 0)
            .then(async () => anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${getServerPort(localProxy)}`))
            .then(async (url) => {
                proxyUrl = url;

                listenConnectAnonymizedProxy(proxyUrl, ({ response }) => {
                    rawHeadersRetrieved = response.rawHeaders;
                });
                return httpRequest({
                    url: `https://${host}`,
                    proxyUrl,
                })
                    .catch(() => {});
            })
            .then(() => {
                expect(rawHeadersRetrieved).toStrictEqual(['foo', 'bar']);
            })
            .finally(async () => closeAnonymizedProxy(proxyUrl, true))
            .finally(() => localProxy.close());
    });

    it('fails with invalid upstream proxy credentials', async () => {
        let anonymousProxyUrl: string;
        return Promise.resolve()
            .then(async () => {
                return anonymizeProxy(`http://username:bad-password@127.0.0.1:${proxyPort}`);
            })
            .then(async (result) => {
                anonymousProxyUrl = result;
                expect(anonymousProxyUrl).not.toContain(`${proxyPort}`);
                wasProxyCalled = false;
                return httpRequest({
                    url: 'http://whatever',
                    proxyUrl: anonymousProxyUrl,
                });
            })
            .then((response) => {
                expect(response.statusCode).toBe(597); // Gateway error
                expect(wasProxyCalled).toBe(false);
            })
            .then(async () => closeAnonymizedProxy(anonymousProxyUrl, true))
            .then((closed) => {
                expect(closed).toBe(true);
            });
    });
});
