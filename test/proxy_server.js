import fs from 'fs';
import path from 'path';
import _ from 'underscore';
import { expect, assert } from 'chai';
import proxy from 'proxy';
import http from 'http';
import portastic from 'portastic';
import basicAuthParser from 'basic-auth-parser';
import Promise from 'bluebird';
import request from 'request';

import { parseUrl, parseProxyAuthorizationHeader } from '../build/tools';
import { ProxyServer } from '../build/proxy_server';
import { TargetServer } from './target_server';

/* globals process */

/*

TODO - add following tests:
- websockets
- lot of small files
- large files (direct / stream)
- various response types
- pages with basic auth
- invalid chain proxy auth
- connection to non-existent server
- ensure no Via and X-Forwarded-For headers are added
- ensure hop-by-hop headers are not passed

- test chain = main proxy lopp

- test authRealm

- test memory is not leaking - run GC before and after test, mem size should be roughly the same
*/


const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

// Enable self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";


const requestPromised = (opts) => {
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) return reject(error);
            resolve(response, body);
        });
    });
};


const createTestSuite = ({ useSsl, useMainProxy, mainProxyAuth, useProxyChain, proxyChainAuth }) => {
    return function() {
        this.timeout(30 * 1000);

        let freePorts;

        let targetServerPort;
        let targetServer;

        let proxyChainServer;
        let proxyChainPort;
        let proxyChainWasCalled = false;

        let mainProxyServer;
        let mainProxyServerPort;

        let baseUrl;
        let mainProxyUrl;
        let getRequestOpts = (path) => {
            return {
                url: `${baseUrl}${path}`,
                key: sslKey,
                proxy: mainProxyUrl,
            }
        };

        before(() => {
            return portastic.find({ min: 50000, max: 50100 }).then((ports) => {
                freePorts = ports;

                // Setup target HTTP server
                targetServerPort = freePorts[0];
                targetServer = new TargetServer({ port: targetServerPort, useSsl, sslKey, sslCrt });
                return targetServer.listen();
            }).then(() => {
                // Setup proxy chain server
                if (useProxyChain) {
                    return new Promise((resolve, reject) => {
                        const proxyChainHttpServer = http.createServer();

                        // Setup proxy authorization
                        proxyChainHttpServer.authenticate = function (req, fn) {
                            // parse the "Proxy-Authorization" header
                            const auth = req.headers['proxy-authorization'];
                            if (!auth) {
                                // optimization: don't invoke the child process if no
                                // "Proxy-Authorization" header was given
                                // console.log('not Proxy-Authorization');
                                return fn(null, false);
                            }

                            const parsed = parseProxyAuthorizationHeader(auth);
                            const isEqual = _.isEqual(parsed, proxyChainAuth);
                            console.log('Parsed "Proxy-Authorization": parsed: %j expected: %j : %s', parsed, proxyChainAuth, isEqual);
                            if (isEqual) proxyChainWasCalled = true;
                            fn(null, isEqual);
                        };

                        proxyChainHttpServer.on('error', (err) => {
                            console.dir(err);
                            throw new Error('Proxy chain HTTP server failed');
                        });

                        proxyChainPort = freePorts[1];
                        proxyChainServer = proxy(proxyChainHttpServer);
                        proxyChainServer.listen(proxyChainPort, (err) => {
                            if (err) return reject(err);
                            resolve();
                        });
                    });
                }
            }).then(() => {
                // Setup main proxy server
                if (useMainProxy) {
                    mainProxyServerPort = freePorts[2];

                    const opts = {
                        port: mainProxyServerPort,
                        verbose: false,
                    };

                    if (mainProxyAuth) {
                        opts.authFunction = ({ request, username, password }) => {
                            return mainProxyAuth.username === username
                                && mainProxyAuth.password === password;
                        }
                    }

                    if (useProxyChain) {
                        opts.proxyChainUrlFunction = ({ request, username, hostname, port, protocol }) => {
                            if (mainProxyAuth
                                && (mainProxyAuth.username !== username || mainProxyAuth.hostname !== hostname)) {
                                throw new Error('proxyChainUrlFunction() didn\'t receive correct username/password?!');
                            }

                            let auth = '';
                            if (proxyChainAuth) {
                                auth = proxyChainAuth.username;
                                if (proxyChainAuth.password) auth += `:${proxyChainAuth.password}`;
                                auth += '@';
                            }
                            return Promise.resolve(`http://${auth}localhost:${proxyChainPort}`);
                        };
                    }

                    mainProxyServer = new ProxyServer(opts);

                    return mainProxyServer.listen();
                }
            }).then(() => {
                // Generate URLs
                baseUrl = `${useSsl ? 'https' : 'http'}://localhost:${targetServerPort}`;

                if (useMainProxy) {
                    let auth = '';
                    if (mainProxyAuth) {
                        auth = mainProxyAuth.username;
                        if (mainProxyAuth.password) auth += `:${proxyChainAuth.password}`;
                        auth += '@';
                    }
                    mainProxyUrl = `http://${auth}localhost:${mainProxyServerPort}`;
                }
            });
        });

        it('handles simple GET request', () => {
            const opts = getRequestOpts('/hello-world');
            return requestPromised(opts)
                .then((response) => {
                    expect(response.body).to.eql('Hello world!');
                    expect(response.statusCode).to.eql(200);
                });
        });

        it('handles 301 redirect', () => {
            const opts = getRequestOpts('/redirect-to-hello-world');
            return requestPromised(opts)
                .then((response) => {
                    expect(response.body).to.eql('Hello world!');
                    expect(response.statusCode).to.eql(200);
                });
        });

        if (useProxyChain) {
            it('really called the proxy chain', () => {
                expect(proxyChainWasCalled).to.eql(true);
            });
        }

        if (useMainProxy) {
            it('returns 400 for direct connection', () => {
                const opts = {
                    url: `${mainProxyUrl}`,
                };
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.statusCode).to.eql(400);
                    });
            });
        }

        after(() => {
            // Shutdown all servers
            return Promise.resolve().then(() => {
                if (mainProxyServer) {
                    return mainProxyServer.close();
                }
            })
            .then(() => {
                if (proxyChainServer) {
                    return Promise.promisify(proxyChainServer.close).bind(proxyChainServer)();
                }
            })
            .then(() => {
                if (targetServer) {
                    return targetServer.close();
                }
            });
        });
    };
};

// Test direct connection to ensure our tests are correct
describe('ProxyServer (HTTP -> Target)', createTestSuite({
    useSsl: false,
    useMainProxy: false,
    useProxyChain: false,
}));

describe('ProxyServer (HTTP -> Proxy -> Target)', createTestSuite({
    useSsl: false,
    useMainProxy: true,
    useProxyChain: false,
}));

describe('ProxyServer (HTTP -> Proxy -> Proxy with username:password -> Target)', createTestSuite({
    useSsl: false,
    useMainProxy: true,
    useProxyChain: true,
    proxyChainAuth: { type: 'Basic', username: 'username', password: 'password' },
}));

describe('ProxyServer (HTTP -> Proxy -> Proxy with username -> Target)', createTestSuite({
    useSsl: false,
    useMainProxy: true,
    useProxyChain: true,
    proxyChainAuth: { type: 'Basic', username: 'username', password: null },
}));

describe('ProxyServer (HTTPS -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: false,
    useProxyChain: false,
}));

describe('ProxyServer (HTTPS -> Proxy -> Proxy -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: true,
    useProxyChain: false
}));

describe('ProxyServer (HTTPS -> Proxy -> Proxy with username:password -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: true,
    useProxyChain: true,
    proxyChainAuth: { type: 'Basic', username: 'username', password: 'password' },
}));

describe('ProxyServer (HTTPS -> Proxy -> Proxy with username -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: true,
    useProxyChain: true,
    proxyChainAuth: { type: 'Basic', username: 'username', password: null },
}));
