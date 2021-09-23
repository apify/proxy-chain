const _ = require('underscore');
const { expect, assert } = require('chai');
const proxy = require('proxy');
const http = require('http');
const util = require('util');
const portastic = require('portastic');
const basicAuthParser = require('basic-auth-parser');
const request = require('request');
const express = require('express');

const { anonymizeProxy, closeAnonymizedProxy } = require('../src/index');

let expressServer;
let proxyServer;
let proxyPort;
let testServerPort;
const proxyAuth = { scheme: 'Basic', username: 'username', password: '' };
let wasProxyCalled = false;

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
                expressServer = app.listen(testServerPort, () => {
                    resolve();
                });
            });
        });
});

after(function () {
    this.timeout(5 * 1000);
    expressServer.close();

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


describe('utils.anonymizeProxyNoPassword', function () {
    // Need larger timeout for Travis CI
    this.timeout(5 * 1000);
    it('anonymizes authenticated with no password upstream proxy (both with callbacks and promises)', () => {
        let proxyUrl1;
        let proxyUrl2;
        return Promise.resolve()
            .then(() => {
                return Promise.all([
                    anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
                    new Promise((resolve, reject) => {
                        anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`,
                            (err, result) => {
                                if (err) return reject(err);
                                resolve(result);
                            });
                    }),
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
});
