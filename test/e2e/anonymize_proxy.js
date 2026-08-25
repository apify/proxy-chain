import _ from 'underscore';
import util from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import proxy from 'proxy';
import http from 'node:http';
import portastic from 'portastic';
import basicAuthParser from 'basic-auth-parser';
import request from 'request';
import express from 'express';

import { anonymizeProxy, closeAnonymizedProxy, listenConnectAnonymizedProxy } from '../../src/index.js';

let expressServer;
let proxyServer;
let proxyPort;
let testServerPort;
const proxyAuth = { scheme: 'Basic', username: 'username', password: 'password' };
let wasProxyCalled = false;

const serverListen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(port, () => {
        server.off('error', reject);

        resolve(server.address().port);
    });
});

// Setup local proxy server and web server for the tests
beforeAll(() => {
    // Find free port for the proxy
    let freePorts;
    return portastic.find({ min: 50000, max: 50100 })
        .then((result) => {
            freePorts = result;
            return new Promise((resolve, reject) => {
                const httpServer = http.createServer();

                // Setup proxy authorization
                httpServer.authenticate = function (req, fn) {
                    // parse the "Proxy-Authorization" header
                    const auth = req.headers['proxy-authorization'];
                    if (!auth) {
                        // optimization: don't invoke the child process if no
                        // "Proxy-Authorization" header was given
                        // console.log('not Proxy-Authorization');
                        return fn(null, false);
                    }
                    const parsed = basicAuthParser(auth);
                    const isEqual = _.isEqual(parsed, proxyAuth);
                    // console.log('Parsed "Proxy-Authorization": parsed: %j expected: %j : %s', parsed, proxyAuth, isEqual);
                    if (isEqual) wasProxyCalled = true;
                    fn(null, isEqual);
                };

                httpServer.on('error', reject);

                proxyServer = proxy(httpServer);
                proxyServer.listen(freePorts[0], () => {
                    proxyPort = proxyServer.address().port;
                    resolve();
                });
            });
        })
        .then(() => {
            const app = express();

            app.get('/', (req, res) => res.send('Hello World!'));

            // eslint-disable-next-line prefer-destructuring
            testServerPort = freePorts[1];
            return new Promise((resolve, reject) => {
                expressServer = app.listen(testServerPort, () => {
                    resolve();
                });
            });
        });
});

afterAll(async () => {
    await new Promise((resolve) => expressServer.close(resolve));

    if (proxyServer) await util.promisify(proxyServer.close.bind(proxyServer))();
}, 5_000);

const requestPromised = (opts) => {
    // console.log('requestPromised');
    // console.dir(opts);
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) return reject(error);
            if (response.statusCode !== 200) {
                return reject(new Error(`Received invalid response code: ${response.statusCode}`));
            }
            if (opts.expectBodyContainsText) expect(body).toContain(opts.expectBodyContainsText);
            resolve();
        });
    });
};

describe('utils.anonymizeProxy', { timeout: 5_000 }, () => {
    it('throws for invalid args', async () => {
        await expect(anonymizeProxy(null)).rejects.toThrow();
        await expect(anonymizeProxy()).rejects.toThrow();
        await expect(anonymizeProxy({})).rejects.toThrow();

        await expect(closeAnonymizedProxy({})).rejects.toThrow();
        await expect(closeAnonymizedProxy()).rejects.toThrow();
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
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        // Test call through proxy 2
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl2,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        // Test again call through proxy 1
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        // Close proxy 1 and verify
        const closed1 = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1).toBe(true);

        // Test proxy is really closed. Node.js 20+ may report 'socket hang up'
        // instead of 'ECONNREFUSED'.
        await expect(requestPromised({ uri: proxyUrl1 })).rejects.toThrow(/ECONNREFUSED|socket hang up/);

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

    it('handles many concurrent calls without port collision', () => {
        const N = 20;
        let proxyUrls;

        return Promise.resolve()
            .then(() => {
                const promises = [];
                for (let i = 0; i < N; i++) {
                    promises.push(anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`));
                }

                return Promise.all(promises);
            })
            .then((results) => {
                const promises = [];
                proxyUrls = results;
                for (let i = 0; i < N; i++) {
                    expect(proxyUrls[i]).not.toContain(`${proxyPort}`);

                    // Test call through proxy
                    promises.push(requestPromised({
                        uri: `http://localhost:${testServerPort}`,
                        proxy: proxyUrls[i],
                        expectBodyContainsText: 'Hello World!',
                    }));
                }

                return Promise.all(promises);
            })
            .then(() => {
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

    it('handles HTTP CONNECT request properly', { timeout: 50_000 }, () => {
        const host = `localhost:${testServerPort}`;
        let onconnectArgs;
        function onconnect(message, socket) {
            onconnectArgs = message;
            socket.write('HTTP/1.1 401 UNAUTHORIZED\r\n\r\n');
            socket.end();
            socket.destroy();
        }

        const localProxy = http.createServer();
        localProxy.on('connect', onconnect);

        let proxyUrl;

        return serverListen(localProxy, 0)
            .then(() => anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${localProxy.address().port}`))
            .then((url) => {
                proxyUrl = url;

                return requestPromised({
                    uri: `https://${host}`,
                    proxy: proxyUrl,
                });
            })
            .then(() => {
                expect.unreachable();
            }, () => {
                expect(onconnectArgs.headers.host).toBe(host);
                expect(onconnectArgs.url).toBe(host);
            })
            .finally(() => closeAnonymizedProxy(proxyUrl, true))
            .finally(() => localProxy.close());
    });

    it('handles HTTP CONNECT callback properly', { timeout: 50_000 }, () => {
        const host = `localhost:${testServerPort}`;
        let rawHeadersRetrieved;
        function onconnect(message, socket) {
            socket.write('HTTP/1.1 200 OK\r\nfoo: bar\r\n\r\n');
            socket.end();
            socket.destroy();
        }

        let proxyUrl;

        const localProxy = http.createServer();
        localProxy.on('connect', onconnect);

        return serverListen(localProxy, 0)
            .then(() => anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${localProxy.address().port}`))
            .then((url) => {
                proxyUrl = url;

                listenConnectAnonymizedProxy(proxyUrl, ({ response, socket, head }) => {
                    rawHeadersRetrieved = response.rawHeaders;
                });
                return requestPromised({
                    uri: `https://${host}`,
                    proxy: proxyUrl,
                })
                    .catch(() => {});
            })
            .then(() => {
                expect(rawHeadersRetrieved).toStrictEqual(['foo', 'bar']);
            })
            .finally(() => closeAnonymizedProxy(proxyUrl, true))
            .finally(() => localProxy.close());
    });

    it('fails with invalid upstream proxy credentials', () => {
        let anonymousProxyUrl;
        return Promise.resolve()
            .then(() => {
                return anonymizeProxy(`http://username:bad-password@127.0.0.1:${proxyPort}`);
            })
            .then((result) => {
                anonymousProxyUrl = result;
                expect(anonymousProxyUrl).not.toContain(`${proxyPort}`);
                wasProxyCalled = false;
                return requestPromised({
                    uri: 'http://whatever',
                    proxy: anonymousProxyUrl,
                });
            })
            .then(() => {
                expect.unreachable();
            })
            .catch((err) => {
                expect(err.message).toContain('Received invalid response code: 597'); // Gateway error
                expect(wasProxyCalled).toBe(false);
            })
            .then(() => closeAnonymizedProxy(anonymousProxyUrl, true))
            .then((closed) => {
                expect(closed).toBe(true);
            });
    });
});
