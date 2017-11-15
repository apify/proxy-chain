import fs from 'fs';
import path from 'path';
import stream from 'stream';
import _ from 'underscore';
import { expect, assert } from 'chai';
import proxy from 'proxy';
import http from 'http';
import portastic from 'portastic';
import Promise from 'bluebird';
import request from 'request';
import WebSocket from 'ws';
import url from 'url';
import HttpsProxyAgent from 'https-proxy-agent';

import { parseUrl, parseProxyAuthorizationHeader } from '../build/tools';
import { Server } from '../build/server';
import { TargetServer } from './target_server';

/* globals process */

/*
TODO - add following tests:
- websockets - direct SSL connection
- test chain = main proxy loop
- test memory is not leaking - run GC before and after test, mem size should be roughly the same
- IPv6 !!!
*/


const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

// Enable self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const NON_EXISTENT_HOSTNAME = 'non-existent-hostname';

// Prepare testing data
let DATA_CHUNKS = [];
let DATA_CHUNKS_COMBINED = '';
const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
for (let i = 0; i < 100; i++ ) {
    let chunk = '';
    for (let i = 0; i < 10000; i++) {
        chunk += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    DATA_CHUNKS.push(chunk);
    DATA_CHUNKS_COMBINED += chunk;
}

const AUTH_REALM = 'TestProxy';

const requestPromised = (opts) => {
    return new Promise((resolve, reject) => {
        const result = request(opts, (error, response, body) => {
            if (error) {
                /*console.log('REQUEST');
                console.dir(response);
                console.dir(body);
                console.dir(result); */
                return reject(error);
            }
            resolve(response, body);
        });
    });
};


const createTestSuite = ({ useSsl, useMainProxy, mainProxyAuth, useUpstreamProxy, upstreamProxyAuth }) => {
    return function() {
        this.timeout(60 * 1000);

        let freePorts;

        let targetServerPort;
        let targetServerWsPort;
        let targetServer;

        let upstreamProxyServer;
        let upstreamProxyPort;
        let upstreamProxyWasCalled = false;
        let upstreamProxyRequestCount = 0;

        let mainProxyServer;
        let mainProxyServerPort;
        let mainProxyRequestCount = 0;

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
                targetServerPort = freePorts.shift();
                targetServerWsPort = freePorts.shift();
                targetServer = new TargetServer({ port: targetServerPort, wsPort: targetServerWsPort, useSsl, sslKey, sslCrt });
                return targetServer.listen();
            }).then(() => {
                // Setup proxy chain server
                if (useUpstreamProxy) {
                    return new Promise((resolve, reject) => {
                        const upstreamProxyHttpServer = http.createServer();

                        // Setup upstream proxy authorization
                        upstreamProxyHttpServer.authenticate = function (req, fn) {
                            upstreamProxyRequestCount++;

                            // Special case: no authentication required
                            if (!upstreamProxyAuth) {
                                upstreamProxyWasCalled = true;
                                return fn(null, true);
                            }

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

                        upstreamProxyPort = freePorts.shift();
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
                    mainProxyServerPort = freePorts.shift();

                    const opts = {
                        port: mainProxyServerPort,
                        //verbose: true,
                    };

                    if (mainProxyAuth || useUpstreamProxy) {
                        opts.prepareRequestFunction = ({ request, username, password, hostname, port, isHttp }) => {
                            const result = {
                                requestAuthentication: false,
                                upstreamProxyUrl: null,
                            };

                            if (mainProxyAuth) {
                                if (mainProxyAuth.username !== username || mainProxyAuth.password !== password) {
                                    result.requestAuthentication = true;
                                    // Now that authentication is requested, upstream proxy should not get used to try some invalid one
                                    result.upstreamProxyUrl = `http://dummy-hostname:4567`;
                                }
                            }

                            if (useUpstreamProxy && !result.upstreamProxyUrl) {
                                let upstreamProxyUrl;

                                if (hostname === 'activate-invalid-upstream-proxy-credentials') {
                                    upstreamProxyUrl = `http://invalid:credentials@localhost:${upstreamProxyPort}`;
                                } else if (hostname === 'activate-invalid-upstream-proxy-host') {
                                    upstreamProxyUrl = `http://dummy-hostname:1234`;
                                } else {
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

                    opts.authRealm = AUTH_REALM;

                    mainProxyServer = new Server(opts);

                    return mainProxyServer.listen();
                }
            }).then(() => {
                // Generate URLs
                baseUrl = `${useSsl ? 'https' : 'http'}://localhost:${targetServerPort}`;

                if (useMainProxy) {
                    let auth = '';
                    if (mainProxyAuth) {
                        auth = mainProxyAuth.username;
                        if (mainProxyAuth.password) auth += `:${mainProxyAuth.password}`;
                        auth += '@';
                    }
                    mainProxyUrl = `http://${auth}localhost:${mainProxyServerPort}`;
                }
            });
        });

        // Helper functions

        // Tests for 502 Bad gateway or 407 Proxy Authenticate
        // Unfortunately the request library throws for HTTPS and sends status code for HTTP
        const testForErrorResponse = (opts, expectedStatusCode) => {
            const promise = requestPromised(opts);
            if (useSsl) {
                return promise.then(() => {
                    assert.fail();
                })
                .catch((err) => {
                    // console.dir(err);
                    expect(err.message).to.contain(`${expectedStatusCode}`);
                });
            } else {
                return promise.then((response) => {
                    expect(response.statusCode).to.eql(expectedStatusCode);
                    return response;
                });
            }
        };

        // Replacement for it() that checks whether the tests really called the main and upstream proxies
        const _it = (description, func) => {
            it(description, () => {
                let upstreamCount = upstreamProxyRequestCount;
                let mainCount = mainProxyServer ? mainProxyServer.stats.connectRequestCount + mainProxyServer.stats.httpRequestCount : null;
                return func()
                    .then(() => {
                        if (useMainProxy) expect(mainCount).to.be.below(mainProxyServer.stats.connectRequestCount + mainProxyServer.stats.httpRequestCount);
                        if (useUpstreamProxy) expect(upstreamCount).to.be.below(upstreamProxyRequestCount);
                    });
            });
        };

        ['GET', 'POST', 'PUT', 'DELETE'].forEach((method) => {
            _it(`handles simple ${method} request`, () => {
                const opts = getRequestOpts('/hello-world');
                opts.method = method;
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.body).to.eql('Hello world!');
                        expect(response.statusCode).to.eql(200);
                    });
            });
        });

        ['POST', 'PUT', 'PATCH'].forEach((method) => {
            _it(`handles ${method} request with payload and passes Content-Type`, () => {
                const opts = getRequestOpts('/echo-payload');
                opts.method = method;
                opts.body = 'SOME BODY LALALALA';
                opts.headers['Content-Type'] = 'text/my-test';
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.body).to.eql(opts.body);
                        expect(response.headers['content-type']).to.eql(opts.headers['Content-Type']);
                        expect(response.statusCode).to.eql(200);
                    });
            });
        });

        _it(`handles large streamed POST payload`, () => {
            const opts = getRequestOpts('/echo-payload');
            opts.headers['Content-Type'] = 'text/my-test';
            opts.method = 'POST';

            let chunkIndex = 0;
            let intervalId;

            return new Promise((resolve, reject) => {
                const passThrough = new stream.PassThrough();
                opts.body = passThrough;

                request(opts, (error, response, body) => {
                    if (error) return reject(error);
                    expect(response.statusCode).to.eql(200);
                    expect(body).to.eql(DATA_CHUNKS_COMBINED);
                    resolve();
                });

                intervalId = setInterval(() => {
                    if (chunkIndex >= DATA_CHUNKS.length) {
                        passThrough.end();
                        return;
                    }
                    passThrough.write(DATA_CHUNKS[chunkIndex++], (err) => {
                        if (err) reject(err);
                    });
                }, 1);
            })
            .finally(() => {
                clearInterval(intervalId);
            });
        });

        const test1MAChars = () => {
            const opts = getRequestOpts('/get-1m-a-chars-together');
            opts.method = 'GET';
            return requestPromised(opts)
                .then((response) => {
                    expect(response.body).to.match(/^a{1000000}$/);
                    expect(response.statusCode).to.eql(200);
                });
        };
        _it(`handles large GET response`, test1MAChars);
        _it(`handles large streamed GET response`, test1MAChars);

        _it('handles 301 redirect', () => {
            const opts = getRequestOpts('/redirect-to-hello-world');
            return requestPromised(opts)
                .then((response) => {
                    expect(response.body).to.eql('Hello world!');
                    expect(response.statusCode).to.eql(200);
                });
        });

        _it('handles basic authentication', () => {
            return Promise.resolve()
                .then(() => {
                    // First test invalid credentials
                    const opts = getRequestOpts('/basic-auth');
                    opts.url = opts.url.replace('://', '://invalid:password@');
                    return requestPromised(opts);
                })
                .then((response) => {
                    expect(response.body).to.eql('Unauthorized');
                    expect(response.statusCode).to.eql(401);
                })
                .then(() => {
                    // Then test valid ones
                    const opts = getRequestOpts('/basic-auth');
                    opts.url = opts.url.replace('://', '://john.doe:Passwd@');
                    return requestPromised(opts);
                })
                .then((response) => {
                    expect(response.body).to.eql('OK');
                    expect(response.statusCode).to.eql(200);
                });
        });


        // const url = `${self.actExecution.workerUrl}/live-status/${self.actExecution._id}`;
        //self.workerWs = new WebSocket(url);

        let testWsCall = (useHttpUpgrade) => {
            return new Promise((resolve, reject) => {
                // Create an instance of the `HttpsProxyAgent` class with the proxy server information
                let agent = null;
                if (useMainProxy) {
                    const options = url.parse(mainProxyUrl);
                    agent = new HttpsProxyAgent(options);
                }

                const wsUrl = useHttpUpgrade
                    ? `${useSsl ? 'https' : 'http'}://localhost:${targetServerPort}`
                    : `${useSsl ? 'wss' : 'ws'}://localhost:${targetServerWsPort}`;
                const ws = new WebSocket(wsUrl, { agent: agent });

                ws.on('error', (err) => {
                    ws.close();
                    reject(err);
                });
                ws.on('open', () => {
                    ws.send('hello world');
                });
                ws.on('message', function (data, flags) {
                    ws.close();
                    resolve(data);
                });
            })
            .then((data) => {
                expect(data).to.eql('I received: hello world');
            });
        };

        _it('handles web socket connection (upgrade from HTTP)', () => {
            return testWsCall(true);
        });

        if (!useSsl) {
            // TODO: make this work also for SSL connection
            _it('handles web socket connection (direct)', () => {
                return testWsCall(false);
            });
        }

        if (useMainProxy) {
            _it('returns 404 for non-existent hostname', () => {
                const opts = getRequestOpts(`http://${NON_EXISTENT_HOSTNAME}`);
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.statusCode).to.eql(404);
                    });
            });

            it('returns 400 for direct connection to main proxy', () => {
                const opts = { url: `${mainProxyUrl}` };
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.statusCode).to.eql(400);
                    });
            });

            _it('removes hop-by-hop headers (HTTP-only) and leaves other ones', () => {
                const opts = getRequestOpts(`/echo-request-info`);
                opts.headers['X-Test-Header'] = 'my-test-value';
                opts.headers['Transfer-Encoding'] = 'identity';
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.statusCode).to.eql(200);
                        expect(response.headers['content-type']).to.eql('application/json');
                        const req = JSON.parse(response.body);
                        expect(req.headers['x-test-header']).to.eql('my-test-value');
                        expect(req.headers['transfer-encoding']).to.eql(useSsl ? 'identity' : undefined);
                    });
            });

            if (mainProxyAuth) {
                it('returns 407 for invalid credentials', () => {
                    return Promise.resolve()
                        .then(() => {
                            // Test no username and password
                            const opts = getRequestOpts('/whatever');
                            opts.proxy = `http://localhost:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(() => {
                            // Test good username and invalid password
                            const opts = getRequestOpts('/whatever');
                            opts.proxy = `http://${mainProxyAuth.username}:bad-password@localhost:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(() => {
                            // Test invalid username and good password
                            const opts = getRequestOpts('/whatever');
                            opts.proxy = `http://bad-username:${mainProxyAuth.password}@localhost:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(() => {
                            // Test invalid username and good password
                            const opts = getRequestOpts('/whatever');
                            opts.proxy = `http://bad-username:bad-password@localhost:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then((response) => {
                            // Check we received our authRealm
                            if (!useSsl) {
                                expect(response.headers['proxy-authenticate']).to.eql(`Basic realm="${AUTH_REALM}"`);
                            }
                        });
                });
            }

            if (useUpstreamProxy) {
                it('fails gracefully on invalid upstream proxy URL', () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-host`);
                    return testForErrorResponse(opts, 502);
                });

                if (upstreamProxyAuth) {
                    _it('fails gracefully on invalid upstream proxy credentials', () => {
                        const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-credentials`);
                        return testForErrorResponse(opts, 502);
                    });
                }
            }
        }

        after(function () {
            this.timeout(2 * 1000);

            // Shutdown all servers
            return Promise.resolve().then(() => {
                //console.log('mainProxyServer');
                if (mainProxyServer) {
                    // NOTE: we need to forcibly close pending connections,
                    // because e.g. on 502 errors in HTTPS mode, the request library
                    // doesn't close the connection and this would timeout
                    return mainProxyServer.close(true);
                }
            })
            .then(() => {
                //console.log('upstreamProxyServer');
                if (upstreamProxyServer) {
                    return Promise.promisify(upstreamProxyServer.close).bind(upstreamProxyServer)();
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


// Test direct connection to target server to ensure our tests are correct
describe('Server (HTTP -> Target)', createTestSuite({
    useSsl: false,
    useMainProxy: false,
}));
describe('Server (HTTPS -> Target)', createTestSuite({
    useSsl: true,
    useMainProxy: false,
}));

// Run all combinations of test parameters
const useSslVariants = [
    false,
    true,
];
const mainProxyAuthVariants = [
    null,
    { username: 'username', password: null },
    { username: 'username', password: 'password' },
];
const useUpstreamProxyVariants = [
    true,
    false,
];
let upstreamProxyAuthVariants = [
    null,
    { type: 'Basic', username: 'username', password: null },
    { type: 'Basic', username: 'username', password: 'password' },
];

useSslVariants.forEach((useSsl) => {
    mainProxyAuthVariants.forEach((mainProxyAuth) => {
        useUpstreamProxyVariants.forEach((useUpstreamProxy) => {

            // If useUpstreamProxy is not used, only try one variant of upstreamProxyAuth
            let variants = upstreamProxyAuthVariants;
            if (!useUpstreamProxy) variants = [ null ];

            variants.forEach((upstreamProxyAuth) => {
                let desc = `Server (${useSsl ? 'HTTPS' : 'HTTP'} -> Main proxy `;

                if (mainProxyAuth) {
                    if (!mainProxyAuth) {
                        desc += 'public ';
                    } else {
                        if (mainProxyAuth.username && mainProxyAuth.password) desc += 'with username:password ';
                        else desc += 'with username '
                    }
                }
                if (useUpstreamProxy) {
                    desc += '-> Upstream proxy ';
                    if (!upstreamProxyAuth) {
                        desc += 'public ';
                    } else {
                        if (upstreamProxyAuth.username && upstreamProxyAuth.password) desc += 'with username:password ';
                        else desc += 'with username '
                    }
                }
                desc += '-> Target)';

                describe(desc, createTestSuite({
                    useMainProxy: true,
                    useSsl,
                    useUpstreamProxy,
                    mainProxyAuth,
                    upstreamProxyAuth,
                }));
            });
        });
    });
});

