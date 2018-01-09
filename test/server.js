import fs from 'fs';
import path from 'path';
import stream from 'stream';
import childProcess from 'child_process';
import dns from 'dns';
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
import { Server, RequestError } from '../build/server';
import { TargetServer } from './target_server';

/* globals process */

/*
TODO - add following tests:
- websockets - direct SSL connection
- test chain = main proxy loop
- test memory is not leaking - run GC before and after test, mem size should be roughly the same
- IPv6 !!!
*/

// See README.md for details
const LOCALHOST_TEST = 'localhost-test';

const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

// Enable self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NON_EXISTENT_HOSTNAME = 'non-existent-hostname';

// Prepare testing data
const DATA_CHUNKS = [];
let DATA_CHUNKS_COMBINED = '';
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
for (let i = 0; i < 100; i++) {
    let chunk = '';
    for (let i = 0; i < 10000; i++) {
        chunk += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    DATA_CHUNKS.push(chunk);
    DATA_CHUNKS_COMBINED += chunk;
}

const AUTH_REALM = 'Test Proxy'; // Test space in realm string

const requestPromised = (opts) => {
    return new Promise((resolve, reject) => {
        const result = request(opts, (error, response, body) => {
            if (error) {
                /* console.log('REQUEST');
                console.dir(response);
                console.dir(body);
                console.dir(result); */
                return reject(error);
            }
            resolve(response, body);
        });
    });
};

// Opens web page in phantomjs and returns the HTML content
const phantomGet = (url, proxyUrl) => {
    const phantomPath = path.join(__dirname, '../node_modules/.bin/phantomjs');
    const scriptPath = path.join(__dirname, './phantom_get.js');

    let proxyParams = '';
    if (proxyUrl) {
        const parsed = parseUrl(proxyUrl);
        proxyParams += `--proxy-type=http --proxy=${parsed.hostname}:${parsed.port} `;
        if (parsed.username || parsed.password) {
            if ((parsed.username && !parsed.password) || (!parsed.username && parsed.password)) {
                throw new Error('PhantomJS cannot handle proxy only username or password!');
            }
            proxyParams += `--proxy-auth=${parsed.username}:${parsed.password} `;
        }
    }

    return new Promise((resolve, reject) => {
        const cmd = `${phantomPath} --ignore-ssl-errors=true ${proxyParams} ${scriptPath} ${url}`;
        childProcess.exec(cmd, (error, stdout, stderr) => {
            if (error) return reject(new Error(`Cannot open page in PhantomJS: ${error}: ${stderr || stdout}`));

            resolve(stdout);
        });
    });
};

const createTestSuite = ({
    useSsl, useMainProxy, mainProxyAuth, useUpstreamProxy, upstreamProxyAuth,
}) => {
    return function () {
        this.timeout(30 * 1000);

        let freePorts;

        let targetServerPort;
        let targetServerWsPort;
        let targetServer;

        let upstreamProxyServer;
        let upstreamProxyPort;
        let upstreamProxyWasCalled = false;
        let upstreamProxyRequestCount = 0;

        let mainProxyServer;
        let mainProxyServerStatisticsInterval;
        const mainProxyServerConnections = {};
        let mainProxyServerPort;
        const mainProxyRequestCount = 0;

        let baseUrl;
        let mainProxyUrl;
        const getRequestOpts = (pathOrUrl) => {
            return {
                url: pathOrUrl[0] === '/' ? `${baseUrl}${pathOrUrl}` : pathOrUrl,
                key: sslKey,
                proxy: mainProxyUrl,
                headers: {},
            };
        };

        let counter = 0;

        before(() => {
            return portastic.find({ min: 50000, max: 50100 }).then((ports) => {
                freePorts = ports;

                // Setup target HTTP server
                targetServerPort = freePorts.shift();
                targetServerWsPort = freePorts.shift();
                targetServer = new TargetServer({
                    port: targetServerPort, wsPort: targetServerWsPort, useSsl, sslKey, sslCrt,
                });
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
                            // console.log('Parsed "Proxy-Authorization": parsed: %j expected: %j : %s', parsed, upstreamProxyAuth, isEqual);
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
                        // verbose: true,
                    };

                    if (mainProxyAuth || useUpstreamProxy) {
                        opts.prepareRequestFunction = ({
                            request, username, password, hostname, port, isHttp, connectionId
                        }) => {
                            const result = {
                                requestAuthentication: false,
                                upstreamProxyUrl: null,
                            };

                            expect(port).to.be.an('number');

                            if (hostname === 'activate-error-in-prep-req-func-throw') {
                                throw new Error('Testing error 1');
                            }
                            if (hostname === 'activate-error-in-prep-req-func-throw-known') {
                                throw new RequestError('Known error 1', 501);
                            }

                            if (hostname === 'activate-error-in-prep-req-func-promise') {
                                return Promise.reject(new Error('Testing error 2'));
                            }
                            if (hostname === 'activate-error-in-prep-req-func-promise-known') {
                                throw new RequestError('Known error 2', 501);
                            }

                            if (mainProxyAuth) {
                                if (mainProxyAuth.username !== username || mainProxyAuth.password !== password) {
                                    result.requestAuthentication = true;
                                    // Now that authentication is requested, upstream proxy should not get used to try some invalid one
                                    result.upstreamProxyUrl = 'http://dummy-hostname:4567';
                                }
                            }

                            if (useUpstreamProxy && !result.upstreamProxyUrl) {
                                let upstreamProxyUrl;

                                if (hostname === 'activate-invalid-upstream-proxy-credentials') {
                                    upstreamProxyUrl = `http://invalid:credentials@127.0.0.1:${upstreamProxyPort}`;
                                } else if (hostname === 'activate-invalid-upstream-proxy-host') {
                                    upstreamProxyUrl = 'http://dummy-hostname:1234';
                                } else {
                                    let auth = '';
                                    if (upstreamProxyAuth) auth = `${upstreamProxyAuth.username}:${upstreamProxyAuth.password}@`;
                                    upstreamProxyUrl = `http://${auth}127.0.0.1:${upstreamProxyPort}`;
                                }

                                result.upstreamProxyUrl = upstreamProxyUrl;
                            }

                            mainProxyServerConnections[connectionId] = {
                                groups: username ? username.replace('groups-', '').split('+') : [],
                                token: password,
                                hostname,
                            };

                            // Sometimes return a promise, sometimes the result directly
                            if (counter++ % 2 === 0) return result;
                            return Promise.resolve(result);
                        };
                    }

                    opts.authRealm = AUTH_REALM;

                    mainProxyServer = new Server(opts);

                    return mainProxyServer.listen();
                }
            })
                .then(() => {
                    // Generate URLs
                    baseUrl = `${useSsl ? 'https' : 'http'}://127.0.0.1:${targetServerPort}`;

                    if (useMainProxy) {
                        let auth = '';
                        if (mainProxyAuth) auth = `${mainProxyAuth.username}:${mainProxyAuth.password}@`;
                        mainProxyUrl = `http://${auth}127.0.0.1:${mainProxyServerPort}`;
                    }
                });
        });

        // Helper functions

        // Tests for 502 Bad gateway or 407 Proxy Authenticate
        // Unfortunately the request library throws for HTTPS and sends status code for HTTP
        const testForErrorResponse = (opts, expectedStatusCode) => {
            let requestError = null;
            const onRequestFailed = (err) => {
                requestError = err;
            };

            mainProxyServer.on('requestFailed', onRequestFailed);

            const promise = requestPromised(opts);

            if (useSsl) {
                return promise.then(() => {
                    assert.fail();
                })
                    .catch((err) => {
                        // console.dir(err);
                        expect(err.message).to.contain(`${expectedStatusCode}`);
                    });
            }
            return promise.then((response) => {
                expect(response.statusCode).to.eql(expectedStatusCode);
                if (expectedStatusCode === 500) {
                    expect(requestError).to.have.own.property('message');
                } else {
                    expect(requestError).to.eql(null);
                }
                return response;
            })
            .finally(() => {
                mainProxyServer.removeListener('requestFailed', onRequestFailed);
            });
        };

        // Replacement for it() that checks whether the tests really called the main and upstream proxies
        const _it = (description, func) => {
            it(description, () => {
                const upstreamCount = upstreamProxyRequestCount;
                const mainCount = mainProxyServer ? mainProxyServer.stats.connectRequestCount + mainProxyServer.stats.httpRequestCount : null;
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

        // NOTE: upstream proxy cannot handle non-standard headers
        if (!useUpstreamProxy) {
            _it(`ignores non-standard server HTTP headers`, () => {
                const opts = getRequestOpts('/get-non-standard-headers');
                opts.method = 'GET';
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.body).to.eql('Hello sir!');
                        expect(response.statusCode).to.eql(200);
                        expect(response.headers).to.be.an('object');

                        // The server returns two headers:
                        //  'Invalid Header With Space': 'HeaderValue1',
                        //  'X-Normal-Header': 'HeaderValue2',
                        // With HTTP proxy, the invalid header should be removed, otherwise it should be present
                        expect(response.headers['x-normal-header']).to.eql('HeaderValue2');
                        if (useMainProxy && !useSsl) {
                            expect(response.headers['invalid header with space']).to.eql(undefined);
                        } else {
                            expect(response.headers['invalid header with space']).to.eql('HeaderValue1');
                        }
                    });
            });
        }

        _it(`save repeating server HTTP headers`, () => {
            const opts = getRequestOpts('/get-repeating-headers');
            opts.method = 'GET';
            return requestPromised(opts)
                .then((response) => {
                    expect(response.body).to.eql('Hooray!');
                    expect(response.statusCode).to.eql(200);
                    expect(response.headers).to.be.an('object');

                    // The server returns two headers with same names:
                    //  ... 'Repeating-Header', 'HeaderValue1' ... 'Repeating-Header', 'HeaderValue2' ...
                    // All headers should be present
                    const firstIndex = response.rawHeaders.indexOf('Repeating-Header');
                    expect(response.rawHeaders[firstIndex + 1]).to.eql('HeaderValue1');
                    const secondIndex = response.rawHeaders.indexOf('Repeating-Header', firstIndex + 1);
                    expect(response.rawHeaders[secondIndex + 1]).to.eql('HeaderValue2');
                });
        });

        _it('handles large streamed POST payload', () => {
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
                    const expectedSize = 1000000; // "a" takes one byte, so one 1 milion "a" should be 1MB

                    // this condition is here because some tests do not use prepareRequestFunction
                    // and therefore are not trackable
                    if (mainProxyServerConnections && Object.keys(mainProxyServerConnections).length) {
                        const sortedIds = Object.keys(mainProxyServerConnections).sort((a, b) => {
                            if (Number(a) < Number(b)) return -1;
                            if (Number(a) > Number(b)) return 1;
                            return 0;
                        });
                        const lastHandler = sortedIds[sortedIds.length - 1];
                        const stats = mainProxyServer.getConnectionStats(lastHandler);

                        // 5% range because network negotiation adds to network trafic
                        expect(stats.srcTxBytes).to.be.within(expectedSize, expectedSize * 1.05);
                        expect(stats.trgRxBytes).to.be.within(expectedSize, expectedSize * 1.05);
                    }
                });
        };
        _it('handles large GET response', test1MAChars);

        // TODO: Test streamed GET
        // _it('handles large streamed GET response', test1MAChars);

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

        // NOTE: PhantomJS cannot handle proxy auth with empty user or password, both need to be present!
        if (!mainProxyAuth || (mainProxyAuth.username && mainProxyAuth.password)) {
            _it('handles GET request from PhantomJS', () => {
                return Promise.resolve()
                    .then(() => {
                        // NOTE: use other hostname than 'localhost' or '127.0.0.1' otherwise PhantomJS would skip the proxy!
                        const url = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                        return phantomGet(url, mainProxyUrl);
                    })
                    .then((response) => {
                        expect(response).to.contain('Hello world!');
                    })
            });
        }

        const testWsCall = (useHttpUpgrade) => {
            return new Promise((resolve, reject) => {
                // Create an instance of the `HttpsProxyAgent` class with the proxy server information
                let agent = null;
                if (useMainProxy) {
                    const options = url.parse(mainProxyUrl);
                    agent = new HttpsProxyAgent(options);
                }

                const wsUrl = useHttpUpgrade
                    ? `${useSsl ? 'https' : 'http'}://127.0.0.1:${targetServerPort}`
                    : `${useSsl ? 'wss' : 'ws'}://127.0.0.1:${targetServerWsPort}`;
                const ws = new WebSocket(wsUrl, { agent });

                ws.on('error', (err) => {
                    ws.close();
                    reject(err);
                });
                ws.on('open', () => {
                    ws.send('hello world');
                });
                ws.on('message', (data, flags) => {
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
                const opts = getRequestOpts('/echo-request-info');
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
                            opts.proxy = `http://127.0.0.1:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(() => {
                            // Test good username and invalid password
                            const opts = getRequestOpts('/whatever');
                            opts.proxy = `http://${mainProxyAuth.username}:bad-password@127.0.0.1:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(() => {
                            // Test invalid username and good password
                            const opts = getRequestOpts('/whatever');
                            opts.proxy = `http://bad-username:${mainProxyAuth.password}@127.0.0.1:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(() => {
                            // Test invalid username and good password
                            const opts = getRequestOpts('/whatever');
                            opts.proxy = `http://bad-username:bad-password@127.0.0.1:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then((response) => {
                            // Check we received our authRealm
                            if (!useSsl) {
                                expect(response.headers['proxy-authenticate']).to.eql(`Basic realm="${AUTH_REALM}"`);
                            }
                        });
                });

                it('returns 500 on error in prepareRequestFunction', () => {
                    return Promise.resolve()
                    .then(() => {
                        const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-throw`);
                        return testForErrorResponse(opts, 500);
                    })
                    .then(() => {
                        const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-promise`);
                        return testForErrorResponse(opts, 500);
                    })
                    .then(() => {
                        const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-throw-known`);
                        return testForErrorResponse(opts, 501);
                    })
                    .then(() => {
                        const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-promise-known`);
                        return testForErrorResponse(opts, 501);
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
            if (mainProxyServerStatisticsInterval) clearInterval(mainProxyServerStatisticsInterval);

            // Shutdown all servers
            return Promise.resolve().then(() => {
                // console.log('mainProxyServer');
                if (mainProxyServer) {
                    // NOTE: we need to forcibly close pending connections,
                    // because e.g. on 502 errors in HTTPS mode, the request library
                    // doesn't close the connection and this would timeout
                    return mainProxyServer.close(true);
                }
            })
                .then(() => {
                // console.log('upstreamProxyServer');
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

describe(`Test ${LOCALHOST_TEST} setup`, () => {
    it('works', () => {
        return Promise.promisify(dns.lookup).bind(dns)(LOCALHOST_TEST, { family: 4 })
            .then((address) => {
                // If this fails, see README.md !!!
                expect(address).to.eql('127.0.0.1');
            });
    });
});

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
    { username: 'user1', password: 'pass1' },
    { username: 'user2', password: '' },
    { username: '', password: 'pass3' },
];
const useUpstreamProxyVariants = [
    true,
    false,
];
const upstreamProxyAuthVariants = [
    null,
    { type: 'Basic', username: 'userA', password: '' },
    { type: 'Basic', username: 'userB', password: 'passA' },
];

useSslVariants.forEach((useSsl) => {
    mainProxyAuthVariants.forEach((mainProxyAuth) => {
        useUpstreamProxyVariants.forEach((useUpstreamProxy) => {
            // If useUpstreamProxy is not used, only try one variant of upstreamProxyAuth
            let variants = upstreamProxyAuthVariants;
            if (!useUpstreamProxy) variants = [null];

            variants.forEach((upstreamProxyAuth) => {
                let desc = `Server (${useSsl ? 'HTTPS' : 'HTTP'} -> Main proxy `;

                if (mainProxyAuth) {
                    if (!mainProxyAuth) {
                        desc += 'public ';
                    } else if (mainProxyAuth.username && mainProxyAuth.password) desc += 'with username:password ';
                    else desc += 'with username only ';
                }
                if (useUpstreamProxy) {
                    desc += '-> Upstream proxy ';
                    if (!upstreamProxyAuth) {
                        desc += 'public ';
                    } else if (upstreamProxyAuth.username && upstreamProxyAuth.password) desc += 'with username:password ';
                    else desc += 'with username only ';
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
