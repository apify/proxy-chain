import _ from 'underscore';
import util from 'node:util';
import { expect, assert } from 'chai';
import proxy from 'proxy';
import http from 'node:http';
import portastic from 'portastic';
import basicAuthParser from 'basic-auth-parser';
import request from 'request';
import express from 'express';

import { anonymizeProxy, closeAnonymizedProxy, listenConnectAnonymizedProxy } from '../src/index.js';
import { expectThrowsAsync } from './utils/throws_async.js';

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
before(() => {
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

after(async function () {
    this.timeout(5 * 1000);

    await new Promise((resolve) => expressServer.close(resolve));

    if (proxyServer) await util.promisify(proxyServer.close.bind(proxyServer))();
});

const requestPromised = (opts) => {
    // console.log('requestPromised');
    // console.dir(opts);
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) return reject(error);
            if (response.statusCode !== 200) {
                return reject(new Error(`Received invalid response code: ${response.statusCode}`));
            }
            if (opts.expectBodyContainsText) expect(body).to.contain(opts.expectBodyContainsText);
            resolve();
        });
    });
};

describe('utils.anonymizeProxy', function () {
    // Need larger timeout for Travis CI
    this.timeout(5 * 1000);
    it('throws for invalid args', () => {
        expectThrowsAsync(async () => { await anonymizeProxy(null); });
        expectThrowsAsync(async () => { await anonymizeProxy(); });
        expectThrowsAsync(async () => { await anonymizeProxy({}); });

        expectThrowsAsync(async () => { await closeAnonymizedProxy({}); });
        expectThrowsAsync(async () => { await closeAnonymizedProxy(); });
        expectThrowsAsync(async () => { await closeAnonymizedProxy(null); });
    });

    it('throws for unsupported https: protocol', () => {
        expectThrowsAsync(async () => { await anonymizeProxy('https://whatever.com'); });
        expectThrowsAsync(async () => { await anonymizeProxy({ url: 'https://whatever.com' }); });
    });

    it('throws for invalid ports', () => {
        expectThrowsAsync(async () => { await anonymizeProxy({ url: 'http://whatever.com', port: -16 }); });
        expectThrowsAsync(async () => {
            await anonymizeProxy({
                url: 'http://whatever.com',
                port: 4324324324,
            });
        });
    });

    it('throws for invalid URLs', () => {
        expectThrowsAsync(async () => { await anonymizeProxy('://whatever.com'); });
        expectThrowsAsync(async () => { await anonymizeProxy('https://whatever.com'); });
        expectThrowsAsync(async () => { await anonymizeProxy({ url: '://whatever.com' }); });
        expectThrowsAsync(async () => { await anonymizeProxy({ url: 'https://whatever.com' }); });
    });

    it('keeps already anonymous proxies', async () => {
        const anonymousProxyUrl = await anonymizeProxy('http://whatever:4567');
        expect(anonymousProxyUrl).to.eql('http://whatever:4567');

        const anonymousProxyUrl2 = await anonymizeProxy('http://whatever:4567');
        expect(anonymousProxyUrl2).to.eql('http://whatever:4567');
    });

    it('anonymizes authenticated upstream proxy', async () => {
        const [proxyUrl1, proxyUrl2] = await Promise.all([
            anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
            anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
        ]);

        expect(proxyUrl1).to.not.contain(`${proxyPort}`);
        expect(proxyUrl2).to.not.contain(`${proxyPort}`);
        expect(proxyUrl1).to.not.equal(proxyUrl2);

        // Test call through proxy 1
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).to.equal(true);

        // Test call through proxy 2
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl2,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).to.equal(true);

        // Test again call through proxy 1
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).to.equal(true);

        // Close proxy 1 and verify
        const closed1 = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1).to.eql(true);

        // Test proxy is really closed
        try {
            await requestPromised({
                uri: proxyUrl1,
            });
            assert.fail();
        } catch (err) {
            // Node.js 20+ may return 'socket hang up' instead of 'ECONNREFUSED'
            const validErrors = ['ECONNREFUSED', 'socket hang up'];
            expect(validErrors.some((e) => err.message.includes(e))).to.equal(true);
        }

        // Close proxy 2
        const closed2 = await closeAnonymizedProxy(proxyUrl2, true);
        expect(closed2).to.eql(true);

        // Test the second-time call to close (should return false)
        const closed1Again = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1Again).to.eql(false);

        // Test another second-time call to close
        const closed2Again = await closeAnonymizedProxy(proxyUrl2, false);
        expect(closed2Again).to.eql(false);
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
                    expect(proxyUrls[i]).to.not.contain(`${proxyPort}`);

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
                expect(wasProxyCalled).to.equal(true);
                const promises = [];

                for (let i = 0; i < N; i++) {
                    promises.push(closeAnonymizedProxy(proxyUrls[i], true));
                }

                return Promise.all(promises);
            })
            .then((results) => {
                for (let i = 0; i < N; i++) {
                    expect(results[i]).to.eql(true);
                }
            });
    });

    it('handles HTTP CONNECT request properly', function () {
        this.timeout(50 * 1000);

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
                expect(false).to.equal(true);
            }, () => {
                expect(onconnectArgs.headers.host).to.equal(host);
                expect(onconnectArgs.url).to.equal(host);
            })
            .finally(() => closeAnonymizedProxy(proxyUrl, true))
            .finally(() => localProxy.close());
    });

    it('handles HTTP CONNECT callback properly', function () {
        this.timeout(50 * 1000);

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
                expect(rawHeadersRetrieved).to.eql(['foo', 'bar']);
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
                expect(anonymousProxyUrl).to.not.contain(`${proxyPort}`);
                wasProxyCalled = false;
                return requestPromised({
                    uri: 'http://whatever',
                    proxy: anonymousProxyUrl,
                });
            })
            .then(() => {
                assert.fail();
            })
            .catch((err) => {
                expect(err.message).to.contains('Received invalid response code: 597'); // Gateway error
                expect(wasProxyCalled).to.equal(false);
            })
            .then(() => closeAnonymizedProxy(anonymousProxyUrl, true))
            .then((closed) => {
                expect(closed).to.eql(true);
            });
    });
});
