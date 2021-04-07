const _ = require('underscore');
const util = require('util');
const { expect, assert } = require('chai');
const proxy = require('proxy');
const http = require('http');
const portastic = require('portastic');
const basicAuthParser = require('basic-auth-parser');
const request = require('request');
const express = require('express');

const { anonymizeProxy, closeAnonymizedProxy, listenConnectAnonymizedProxy } = require('../build/index');
const { findFreePort } = require('./tools');

let proxyServer;
let proxyPort; // eslint-disable-line no-unused-vars
let testServerPort;
const proxyAuth = { scheme: 'Basic', username: 'username', password: 'password' };
let wasProxyCalled = false; // eslint-disable-line no-unused-vars

const serverListen = (server, port) => new Promise((resolve, reject) => {
    server.listen(port, (err) => {
        if (err) return reject(err);
        return resolve(port);
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

            testServerPort = freePorts[1];
            return new Promise((resolve, reject) => {
                app.listen(testServerPort, (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });
        });
});

after(function () {
    this.timeout(5 * 1000);
    if (proxyServer) return util.promisify(proxyServer.close).bind(proxyServer)();
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
        assert.throws(() => { anonymizeProxy(null); }, Error);
        assert.throws(() => { anonymizeProxy(); }, Error);
        assert.throws(() => { anonymizeProxy({}); }, Error);

        assert.throws(() => { closeAnonymizedProxy({}); }, Error);
        assert.throws(() => { closeAnonymizedProxy(); }, Error);
        assert.throws(() => { closeAnonymizedProxy(null); }, Error);
    });

    it('throws for unsupported proxy protocols', () => {
        assert.throws(() => { anonymizeProxy('socks://whatever.com'); }, Error);
        assert.throws(() => { anonymizeProxy('https://whatever.com'); }, Error);
        assert.throws(() => { anonymizeProxy('socks5://whatever.com'); }, Error);
    });

    it('throws for invalid URLs', () => {
        assert.throws(() => { anonymizeProxy('://whatever.com'); }, Error);
        assert.throws(() => { anonymizeProxy('https://whatever.com'); }, Error);
        assert.throws(() => { anonymizeProxy('socks5://whatever.com'); }, Error);
    });

    it('keeps already anonymous proxies (both with callbacks and promises)', () => {
        return Promise.resolve()
            .then(() => {
                return anonymizeProxy('http://whatever:4567');
            })
            .then((anonymousProxyUrl) => {
                expect(anonymousProxyUrl).to.eql('http://whatever:4567');
            })
            .then(() => {
                return new Promise((resolve, reject) => {
                    anonymizeProxy('http://whatever:4567', (err, result) => {
                        if (err) return reject(err);
                        resolve(result);
                    });
                });
            })
            .then((anonymousProxyUrl) => {
                expect(anonymousProxyUrl).to.eql('http://whatever:4567');
            });
    });

    it('anonymizes authenticated upstream proxy (both with callbacks and promises)', () => {
        let proxyUrl1;
        let proxyUrl2;
        return Promise.resolve()
            .then(() => {
                return Promise.all([
                    anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
                    new Promise((resolve, reject) => {
                        anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`, (err, result) => {
                            if (err) return reject(err);
                            resolve(result);
                        });
                    })
                ]);
            })
            .then((results) => {
                proxyUrl1 = results[0];
                proxyUrl2 = results[1];
                expect(proxyUrl1).to.not.contain(`${proxyPort}`);
                expect(proxyUrl2).to.not.contain(`${proxyPort}`);
                expect(proxyUrl1).to.not.equal(proxyUrl2);

                // Test call through proxy 1
                wasProxyCalled = false;
                return requestPromised({
                    uri: `http://localhost:${testServerPort}`,
                    proxy: proxyUrl1,
                    expectBodyContainsText: 'Hello World!',
                });
            })
            .then(() => {
                expect(wasProxyCalled).to.equal(true);
            })
            .then(() => {
                // Test call through proxy 2
                wasProxyCalled = false;
                return requestPromised({
                    uri: `http://localhost:${testServerPort}`,
                    proxy: proxyUrl2,
                    expectBodyContainsText: 'Hello World!',
                });
            })
            .then(() => {
                expect(wasProxyCalled).to.equal(true);
            })
            .then(() => {
                // Test again call through proxy 1
                wasProxyCalled = false;
                return requestPromised({
                    uri: `http://localhost:${testServerPort}`,
                    proxy: proxyUrl1,
                    expectBodyContainsText: 'Hello World!',
                });
            })
            .then(() => {
                expect(wasProxyCalled).to.equal(true);
            })
            .then(() => {
                return closeAnonymizedProxy(proxyUrl1, true);
            })
            .then((closed) => {
                expect(closed).to.eql(true);

                // Test proxy is really closed
                return requestPromised({
                    uri: proxyUrl1,
                })
                .then(() => {
                    assert.fail();
                })
                .catch((err) => {
                    expect(err.message).to.contain('ECONNREFUSED');
                });
            })
            .then(() => {
                // Test callback-style
                return new Promise((resolve, reject) => {
                    closeAnonymizedProxy(proxyUrl2, true, (err, closed) => {
                        if (err) return reject(err);
                        resolve(closed);
                    });
                });
            })
            .then((closed) => {
                expect(closed).to.eql(true);

                // Test the second-time call to close
                return closeAnonymizedProxy(proxyUrl1, true);
            })
            .then((closed) => {
                expect(closed).to.eql(false);

                // Test callback-style
                return new Promise((resolve, reject) => {
                    closeAnonymizedProxy(proxyUrl2, false, (err, closed) => {
                        if (err) return reject(err);
                        resolve(closed);
                    });
                });
            })
            .then((closed) => {
                expect(closed).to.eql(false);
            });
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
                for (let i=0; i<N; i++) {
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

                for (let i=0; i<N; i++) {
                    promises.push(closeAnonymizedProxy(proxyUrls[i], true));
                }

                return Promise.all(promises);
            })
            .then((results) => {
                for (let i=0; i<N; i++) {
                    expect(results[i]).to.eql(true);
                }
            });
    });

    it('handles HTTP CONNECT request properly', function () {

        this.timeout(50 * 1000);

        const host = `localhost:${testServerPort}`;
        let proxyPort;
        let onconnectArgs;
        function onconnect(message, socket) {
            onconnectArgs = message;
            socket.write("HTTP/1.1 401 UNAUTHORIZED\r\n\r\n");
            socket.end();
            socket.destroy();
        }
        return findFreePort()
            .then((port) => {
                var proxy = http.createServer();
                proxy.on('connect', onconnect);
                proxyPort = port;
                return serverListen(proxy, proxyPort);
            })
            .then(() => {
                return anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`);
            })
            .then((proxyUrl) => {
                return requestPromised({
                    uri: `https://${host}`,
                    proxy: proxyUrl,
                })
                    .catch(() => {
                        return Promise.resolve();
                    });
            })
            .then(() => {
                expect(onconnectArgs.headers.host).to.equal(host);
                expect(onconnectArgs.url).to.equal(host);
            });
    });

    it('handles HTTP CONNECT callback properly', function () {

        this.timeout(50 * 1000);

        const host = `localhost:${testServerPort}`;
        let proxyPort;
        let rawHeadersRetrieved;
        function onconnect(message, socket) {
            socket.write("HTTP/1.1 200 OK\r\nfoo: bar\r\n\r\n");
            socket.end();
            socket.destroy();
        }
        return findFreePort()
            .then((port) => {
                var proxy = http.createServer();
                proxy.on('connect', onconnect);
                proxyPort = port;
                return serverListen(proxy, proxyPort);
            })
            .then(() => {
                return anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`);
            })
            .then((proxyUrl) => {
                listenConnectAnonymizedProxy(proxyUrl, ({ response, socket, head }) => {
                    rawHeadersRetrieved = response.rawHeaders;
                });
                return requestPromised({
                    uri: `https://${host}`,
                    proxy: proxyUrl,
                })
                .catch(() => {
                    return Promise.resolve();
                });
            })
            .then(() => {
                expect(rawHeadersRetrieved).to.eql(['foo', 'bar']);
            });
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
                expect(err.message).to.contains('Received invalid response code: 502'); // Gateway error
                expect(wasProxyCalled).to.equal(false);
            })
            .then(() => {
                return closeAnonymizedProxy(anonymousProxyUrl, true);
            })
            .then((closed) => {
                expect(closed).to.eql(true);
            });
    });
});
