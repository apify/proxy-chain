import fs from 'fs';
import path from 'path';
import _ from 'underscore';
import { expect, assert } from 'chai';
import proxy from 'proxy';
import http from 'http';
import portastic from 'portastic';
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

const NON_EXISTENT_HOSTNAME = 'non-existent-hostname';


const requestPromised = (opts) => {
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) return reject(error);
            resolve(response, body);
        });
    });
};


const createTestSuite = ({ useSsl, useMainProxy, mainProxyAuth, useChainedProxy, upstreamProxyAuth }) => {
    return function() {
        this.timeout(30 * 1000);

        let freePorts;

        let targetServerPort;
        let targetServer;

        let upstreamProxyServer;
        let upstreamProxyPort;
        let upstreamProxyWasCalled = false;

        let mainProxyServer;
        let mainProxyServerPort;

        let baseUrl;
        let mainProxyUrl;
        let getRequestOpts = (pathOrUrl) => {
            return {
                url: pathOrUrl[0] === '/' ? `${baseUrl}${pathOrUrl}` : pathOrUrl,
                key: sslKey,
                proxy: mainProxyUrl,
                headers: {},
            }
        };

        let counter = 0;

        before(() => {
            return portastic.find({ min: 50000, max: 50100 }).then((ports) => {
                freePorts = ports;

                // Setup target HTTP server
                targetServerPort = freePorts[0];
                targetServer = new TargetServer({ port: targetServerPort, useSsl, sslKey, sslCrt });
                return targetServer.listen();
            }).then(() => {
                // Setup proxy chain server
                if (useChainedProxy) {
                    return new Promise((resolve, reject) => {
                        const upstreamProxyHttpServer = http.createServer();

                        // Setup proxy authorization
                        upstreamProxyHttpServer.authenticate = function (req, fn) {
                            // parse the "Proxy-Authorization" header
                            const auth = req.headers['proxy-authorization'];
                            if (!auth) {
                                // optimization: don't invoke the child process if no
                                // "Proxy-Authorization" header was given
                                // console.log('not Proxy-Authorization');
                                return fn(null, false);
                            }

                            const parsed = parseProxyAuthorizationHeader(auth);
                            const isEqual = _.isEqual(parsed, upstreamProxyAuth);
                            //console.log('Parsed "Proxy-Authorization": parsed: %j expected: %j : %s', parsed, upstreamProxyAuth, isEqual);
                            if (isEqual) upstreamProxyWasCalled = true;
                            fn(null, isEqual);
                        };

                        upstreamProxyHttpServer.on('error', (err) => {
                            console.dir(err);
                            throw new Error('Upstream proxy HTTP server failed');
                        });

                        upstreamProxyPort = freePorts[1];
                        upstreamProxyServer = proxy(upstreamProxyHttpServer);
                        upstreamProxyServer.listen(upstreamProxyPort, (err) => {
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
                        verbose: true,
                    };

                    if (mainProxyAuth || useChainedProxy) {
                        opts.prepareRequestFunction = ({ request, username, password, hostname, port, isHttp }) => {

                            const result = {
                                requestAuthentication: false,
                                upstreamProxyUrl: null,
                            };

                            if (mainProxyAuth) {
                                result.requestAuthentication = mainProxyAuth.username !== username || mainProxyAuth.password !== password;
                            }

                            if (useChainedProxy) {
                                let upstreamProxyUrl;

                                if (hostname === 'activate-invalid-upstream-proxy-credentials') {
                                    upstreamProxyUrl = `http://invalid:credentials@localhost:${upstreamProxyPort}`;
                                } else if (hostname === 'activate-invalid-upstream-proxy-host') {
                                    upstreamProxyUrl = `http://dummy-hostname:1234`;
                                } else {
                                    if (mainProxyAuth
                                        && (mainProxyAuth.username !== username || mainProxyAuth.hostname !== hostname)) {
                                        throw new Error('upstreamProxyUrlFunction() didn\'t receive correct username/password?!');
                                    }

                                    let auth = '';
                                    if (upstreamProxyAuth) {
                                        auth = upstreamProxyAuth.username;
                                        if (upstreamProxyAuth.password) auth += `:${upstreamProxyAuth.password}`;
                                        auth += '@';
                                    }

                                    upstreamProxyUrl = `http://${auth}localhost:${upstreamProxyPort}`;
                                }

                                result.upstreamProxyUrl = upstreamProxyUrl;
                            }

                            // Sometimes return a promise, sometimes the result directly
                            if (counter++ % 2 === 0) return result;
                            else return Promise.resolve(result);
                        }
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
                        if (mainProxyAuth.password) auth += `:${upstreamProxyAuth.password}`;
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

        if (useChainedProxy) {
            it('really called the upstream proxy', () => {
                expect(upstreamProxyWasCalled).to.eql(true);
            });

            it('fails gracefully on invalid upstream proxy URL', () => {
                const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-host`);
                // Otherwise the socket would be kept open and mainProxy close would timeout
                // opts.headers['Connection'] = 'close';
                // The proxy should fail with 502 Bad gateway, unfortunatell the request library throws for HTTPS and sends 502 for HTTP
                const promise = requestPromised(opts);
                if (useSsl) {
                    return promise.then(() => {
                        assert.fail();
                    })
                    .catch((err) => {
                        expect(err.message).to.contain('502');
                    });
                } else {
                    return promise.then((response) => {
                        expect(response.statusCode).to.eql(502);
                    });
                }
            });

            /*
            it('fails gracefully on invalid chained proxy credentials', () => {
                const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-credentials`);
                return requestPromised(opts)
                    .then((response) => {
                        console.log(response.body);
                        expect(response.statusCode).to.eql(200);
                    });
            });
            */
        }


        if (useMainProxy) {
            it('returns 404 for non-existent hostname', () => {
                const opts = getRequestOpts(`http://${NON_EXISTENT_HOSTNAME}`);
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.statusCode).to.eql(404);
                    });
            });

            it('returns 400 for direct connection to main proxy', () => {
                const opts = {
                    url: `${mainProxyUrl}`,
                };
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.statusCode).to.eql(400);
                    });
            });
        }

        after(function () {
            this.timeout(5 * 1000);

            // Shutdown all servers
            return Promise.resolve().then(() => {
                if (mainProxyServer) {
                    console.log('shutting down mainProxyServer');
                    return mainProxyServer.close();
                }
            })
            .then(() => {
                if (upstreamProxyServer) {
                    console.log('shutting down upstreamProxyServer');
                    return Promise.promisify(upstreamProxyServer.close).bind(upstreamProxyServer)();
                }
            })
            .then(() => {
                if (targetServer) {
                    console.log('shutting down targetServer');
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
    useChainedProxy: false,
}));

describe('ProxyServer (HTTP -> Proxy -> Target)', createTestSuite({
    useSsl: false,
    useMainProxy: true,
    useChainedProxy: false,
}));

describe('ProxyServer (HTTP -> Proxy -> Proxy with username:password -> Target)', createTestSuite({
    useSsl: false,
    useMainProxy: true,
    useChainedProxy: true,
    upstreamProxyAuth: { type: 'Basic', username: 'username', password: 'password' },
}));

describe('ProxyServer (HTTP -> Proxy -> Proxy with username -> Target)', createTestSuite({
    useSsl: false,
    useMainProxy: true,
    useChainedProxy: true,
    upstreamProxyAuth: { type: 'Basic', username: 'username', password: null },
}));

describe('ProxyServer (HTTPS -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: false,
    useChainedProxy: false,
}));

describe('ProxyServer (HTTPS -> Proxy -> Proxy -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: true,
    useChainedProxy: false
}));

describe('ProxyServer (HTTPS -> Proxy -> Proxy with username:password -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: true,
    useChainedProxy: true,
    upstreamProxyAuth: { type: 'Basic', username: 'username', password: 'password' },
}));

describe('ProxyServer (HTTPS -> Proxy -> Proxy with username -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: true,
    useChainedProxy: true,
    upstreamProxyAuth: { type: 'Basic', username: 'username', password: null },
}));
