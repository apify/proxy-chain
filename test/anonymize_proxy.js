const _ = require('underscore');
const util = require('util');
const { expect, assert } = require('chai');
const proxy = require('proxy');
const http = require('http');
const portastic = require('portastic');
const basicAuthParser = require('basic-auth-parser');
const request = require('request');
const express = require('express');

const { anonymizeProxy, closeAnonymizedProxy, listenConnectAnonymizedProxy } = require('../src/index');

let proxyServer;
let proxyPort;
let testServerPort;
const proxyAuth = { scheme: 'Basic', username: 'username', password: 'password' };
let wasProxyCalled = false;

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
