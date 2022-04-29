const fs = require('fs');
const path = require('path');
const stream = require('stream');
const childProcess = require('child_process');
const net = require('net');
const dns = require('dns');
const util = require('util');
const { expect, assert } = require('chai');
const proxy = require('proxy');
const http = require('http');
const portastic = require('portastic');
const request = require('request');
const WebSocket = require('faye-websocket');
const { gotScraping } = require('got-scraping');

const { parseAuthorizationHeader } = require('../src/utils/parse_authorization_header');
const { Server, RequestError } = require('../src/index');
const { TargetServer } = require('./utils/target_server');
const ProxyChain = require('../src/index');

/*
TODO - add following tests:
- gzip Content-Encoding
- IPv6 !!!
- raw TCP connection over proxy
- HandlerForward when connected through shader proxy threw error if source socket was closed instead of response, test why.
*/

// See README.md for details
const LOCALHOST_TEST = 'localhost-test';

const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

// Enable self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NON_EXISTENT_HOSTNAME = 'this-apify-hostname-is-surely-non-existent.cz';

// Prepare testing data
const DATA_CHUNKS = [];
let DATA_CHUNKS_COMBINED = '';
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
for (let i = 0; i < 100; i++) {
    let chunk = '';
    for (let j = 0; j < 10000; j++) {
        chunk += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    DATA_CHUNKS.push(chunk);
    DATA_CHUNKS_COMBINED += chunk;
}

const AUTH_REALM = 'Test Proxy'; // Test space in realm string

const requestPromised = (opts) => {
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) {
                return reject(error);
            }
            resolve(response, body);
        });
    });
};

const wait = (timeout) => new Promise((resolve) => setTimeout(resolve, timeout));

// Opens web page in phantomjs and returns the HTML content
const phantomGet = (url, proxyUrl) => {
    const phantomPath = path.join(__dirname, '../node_modules/.bin/phantomjs');
    const scriptPath = path.join(__dirname, './phantom_get.js');

    let proxyParams = '';
    if (proxyUrl) {
        const parsed = new URL(proxyUrl);
        const username = decodeURIComponent(parsed.username);
        const password = decodeURIComponent(parsed.password);

        proxyParams += `--proxy-type=http --proxy=${parsed.hostname}:${parsed.port} `;
        if (username || password) {
            if ((username && !password) || (!username && password)) {
                throw new Error('PhantomJS cannot handle proxy only username or password!');
            }
            proxyParams += `--proxy-auth=${username}:${password} `;
        }
    }

    return new Promise((resolve, reject) => {
        const cmd = `${phantomPath} --ignore-ssl-errors=true ${proxyParams} ${scriptPath} ${url}`;
        childProcess.exec(cmd, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(`Cannot open page in PhantomJS: ${error}: ${stderr || stdout}`));
            }
            resolve(stdout);
        });
    });
};

// Opens web page in curl and returns the HTML content.
// The thing is, on error curl closes the connection immediately, which used to cause
// uncaught ECONNRESET error. See https://github.com/apify/proxy-chain/issues/53
// This is a regression test for that situation
const curlGet = (url, proxyUrl, returnResponse) => {
    let cmd = 'curl --insecure '; // ignore SSL errors
    if (proxyUrl) cmd += `-x ${proxyUrl} `; // use proxy
    if (returnResponse) cmd += `--silent --output - ${url}`; // print response to stdout
    else cmd += `${url}`;
    // console.log(`curlGet(): ${cmd}`);

    return new Promise((resolve, reject) => {
        childProcess.exec(cmd, (error, stdout, stderr) => {
            // NOTE: It's okay if curl exits with non-zero code, that happens e.g. on 407 error over HTTPS
            resolve(stderr || stdout);
        });
    });
};

/**
 * This function creates a function to test the proxy, with specific configuration options.
 * This is to avoid duplication of the code, since many of the tests are same for the specific configurations.
 * @return {function(...[*]=)}
 */
const createTestSuite = ({
    useSsl, useMainProxy, mainProxyAuth, useUpstreamProxy, upstreamProxyAuth, testCustomResponse,
}) => {
    return function () {
        this.timeout(30 * 1000);

        let freePorts;

        let targetServerPort;
        let targetServer;

        let upstreamProxyServer;
        let upstreamProxyPort;
        // eslint is dumb
        // eslint-disable-next-line no-unused-vars
        let upstreamProxyWasCalled = false;
        let upstreamProxyRequestCount = 0;

        let mainProxyServer;
        let mainProxyServerStatisticsInterval;
        const mainProxyServerConnections = {};
        let mainProxyServerPort;
        // eslint is dumb
        // eslint-disable-next-line no-unused-vars
        const mainProxyRequestCount = 0;
        const mainProxyServerConnectionIds = [];
        const mainProxyServerConnectionsClosed = [];
        const mainProxyServerConnectionId2Stats = {};

        let upstreamProxyHostname = '127.0.0.1';

        let baseUrl;
        let mainProxyUrl;
        const getRequestOpts = (pathOrUrl) => {
            return {
                url: pathOrUrl[0] === '/' ? `${baseUrl}${pathOrUrl}` : pathOrUrl,
                key: sslKey,
                proxy: mainProxyUrl,
                headers: {},
                timeout: 30000,
            };
        };

        let counter = 0;

        before(() => {
            return portastic.find({ min: 50000, max: 50500 }).then((ports) => {
                freePorts = ports;

                // Setup target HTTP server
                targetServerPort = freePorts.shift();
                targetServer = new TargetServer({
                    port: targetServerPort, useSsl, sslKey, sslCrt,
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

                            const parsed = parseAuthorizationHeader(auth);
                            const isEqual = ['type', 'username', 'password'].every((name) => parsed[name] === upstreamProxyAuth[name]);
                            // console.log('Parsed "Proxy-Authorization": parsed: %j expected: %j : %s', parsed, upstreamProxyAuth, isEqual);
                            if (upstreamProxyAuth === null || isEqual) upstreamProxyWasCalled = true;
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

                        // This is a workaround to a buggy implementation of "proxy" package. On Node 10+,
                        // the socket sometimes emits ECONNRESET error, which would break the test.
                        // We just swallow it.
                        upstreamProxyServer.on('connect', (req, socket) => {
                            socket.on('error', (err) => {
                                if (err.code === 'ECONNRESET') return;
                                throw err;
                            });
                        });
                    });
                }
            }).then(() => {
                // Setup main proxy server
                if (useMainProxy) {
                    mainProxyServerPort = freePorts.shift();

                    const opts = {
                        port: mainProxyServerPort,
                        // verbose: true, // Enable this if you want verbose logs
                    };

                    if (mainProxyAuth || useUpstreamProxy || testCustomResponse) {
                        opts.prepareRequestFunction = ({
                            request, username, password, hostname, port, isHttp, connectionId,
                        }) => {
                            const result = {
                                requestAuthentication: false,
                                upstreamProxyUrl: null,
                            };
                            // If prepareRequestFunction() will cause error, don't add to this test array as it will fail in after()
                            let addToMainProxyServerConnectionIds = true;

                            expect(request).to.be.an('object');
                            expect(port).to.be.an('number');

                            // All the fake hostnames here have a .gov TLD, because without a TLD,
                            // the tests would fail on GitHub Actions. We assume nobody will register
                            // those random domains with a .gov TLD.
                            if (hostname === 'activate-error-in-prep-req-func-throw.gov') {
                                throw new Error('Testing error 1');
                            }
                            if (hostname === 'activate-error-in-prep-req-func-throw-known.gov') {
                                throw new RequestError('Known error 1', 501);
                            }

                            if (hostname === 'activate-error-in-prep-req-func-promise.gov') {
                                return Promise.reject(new Error('Testing error 2'));
                            }
                            if (hostname === 'activate-error-in-prep-req-func-promise-known.gov') {
                                throw new RequestError('Known error 2', 501);
                            }

                            if (hostname === 'test-custom-response-simple.gov') {
                                result.customResponseFunction = () => {
                                    const trgParsed = new URL(request.url);
                                    expect(trgParsed.host).to.be.eql(hostname);
                                    expect(trgParsed.pathname).to.be.eql('/some/path');
                                    return {
                                        body: 'TEST CUSTOM RESPONSE SIMPLE',
                                    };
                                };
                                // With SSL custom responses are not supported,
                                // we're testing this hence this below
                                if (useSsl) addToMainProxyServerConnectionIds = false;
                            }

                            if (hostname === 'test-custom-response-complex.gov') {
                                result.customResponseFunction = () => {
                                    const trgParsed = new URL(request.url);
                                    expect(trgParsed.hostname).to.be.eql(hostname);
                                    expect(trgParsed.pathname).to.be.eql('/some/path');
                                    expect(trgParsed.search).to.be.eql('?query=456');
                                    expect(port).to.be.eql(1234);
                                    return {
                                        statusCode: 201,
                                        headers: {
                                            'My-Test-Header1': 'bla bla bla',
                                            'My-Test-Header2': 'bla bla bla2',
                                        },
                                        body: 'TEST CUSTOM RESPONSE COMPLEX',
                                    };
                                };
                            }

                            if (hostname === 'test-custom-response-long.gov') {
                                result.customResponseFunction = () => {
                                    const trgParsed = new URL(request.url);
                                    expect(trgParsed.host).to.be.eql(hostname);
                                    expect(trgParsed.pathname).to.be.eql('/');
                                    return {
                                        body: 'X'.repeat(5000000),
                                    };
                                };
                            }

                            if (hostname === 'test-custom-response-promised.gov') {
                                result.customResponseFunction = () => {
                                    const trgParsed = new URL(request.url);
                                    expect(trgParsed.host).to.be.eql(hostname);
                                    expect(trgParsed.pathname).to.be.eql('/some/path');
                                    return Promise.resolve().then(() => {
                                        return {
                                            body: 'TEST CUSTOM RESPONSE PROMISED',
                                        };
                                    });
                                };
                            }

                            if (hostname === 'test-custom-response-invalid.gov') {
                                result.customResponseFunction = 'THIS IS NOT A FUNCTION';
                                addToMainProxyServerConnectionIds = false;
                            }

                            if (mainProxyAuth) {
                                if (mainProxyAuth.username !== username || mainProxyAuth.password !== password) {
                                    result.requestAuthentication = true;
                                    addToMainProxyServerConnectionIds = false;
                                    // Now that authentication is requested, upstream proxy should not get used,
                                    // so try some invalid one and it should cause no issue
                                    result.upstreamProxyUrl = 'http://dummy-hostname-xyz.gov:6789';
                                }
                            }

                            if (useUpstreamProxy && !result.upstreamProxyUrl) {
                                let upstreamProxyUrl;

                                if (hostname === 'activate-invalid-upstream-proxy-scheme.gov') {
                                    upstreamProxyUrl = 'ftp://proxy.example.com:8000';
                                    addToMainProxyServerConnectionIds = false;
                                } else if (hostname === 'activate-invalid-upstream-proxy-url.gov') {
                                    upstreamProxyUrl = '    ';
                                    addToMainProxyServerConnectionIds = false;
                                } else if (hostname === 'activate-invalid-upstream-proxy-username') {
                                    // Colon in proxy username is forbidden!
                                    upstreamProxyUrl = 'http://us%3Aer:pass@proxy.example.com:8000';
                                    addToMainProxyServerConnectionIds = false;
                                } else if (hostname === 'activate-bad-upstream-proxy-credentials.gov') {
                                    upstreamProxyUrl = `http://invalid:credentials@127.0.0.1:${upstreamProxyPort}`;
                                } else if (hostname === 'activate-unknown-upstream-proxy-host.gov') {
                                    upstreamProxyUrl = 'http://dummy-hostname.gov:1234';
                                } else {
                                    let auth = '';
                                    // NOTE: We URI-encode just username, not password, which might contain
                                    if (upstreamProxyAuth) {
                                        auth = `${encodeURIComponent(upstreamProxyAuth.username)}:${encodeURIComponent(upstreamProxyAuth.password)}@`;
                                    }

                                    upstreamProxyUrl = `http://${auth}${upstreamProxyHostname}:${upstreamProxyPort}`;
                                }

                                result.upstreamProxyUrl = upstreamProxyUrl;
                            }

                            if (addToMainProxyServerConnectionIds) {
                                mainProxyServerConnectionIds.push(connectionId);
                                mainProxyServerConnections[connectionId] = {
                                    groups: username ? username.replace('groups-', '').split('+') : [],
                                    token: password,
                                    hostname,
                                };
                            }

                            // Sometimes return a promise, sometimes the result directly
                            if (counter++ % 2 === 0) return result;
                            return Promise.resolve(result);
                        };
                    }

                    opts.authRealm = AUTH_REALM;

                    mainProxyServer = new Server(opts);

                    mainProxyServer.on('connectionClosed', ({ connectionId, stats }) => {
                        assert.include(mainProxyServer.getConnectionIds(), connectionId);
                        mainProxyServerConnectionsClosed.push(connectionId);
                        const index = mainProxyServerConnectionIds.indexOf(connectionId);
                        mainProxyServerConnectionIds.splice(index, 1);
                        mainProxyServerConnectionId2Stats[connectionId] = stats;
                    });

                    return mainProxyServer.listen();
                }
            })
                .then(() => {
                    // Generate URLs
                    baseUrl = `${useSsl ? 'https' : 'http'}://127.0.0.1:${targetServerPort}`;

                    // Ensure the port numbers are correct
                    if (mainProxyServer) {
                        expect(mainProxyServer.port).to.be.eql(mainProxyServerPort);
                        expect(mainProxyServer.server.address().port).to.be.eql(mainProxyServerPort);
                    }

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
            let failedRequest = null;
            const onRequestFailed = ({ error, request }) => {
                requestError = error;
                failedRequest = request;
            };

            mainProxyServer.on('requestFailed', onRequestFailed);

            const promise = requestPromised(opts);

            if (useSsl) {
                return promise.then(() => {
                    assert.fail();
                })
                    .catch((err) => {
                        expect(err.message).to.contain(`${expectedStatusCode}`);
                    })
                    .finally(() => {
                        mainProxyServer.removeListener('requestFailed', onRequestFailed);
                    });
            }
            return promise.then((response) => {
                expect(response.statusCode).to.eql(expectedStatusCode);
                expect(response.headers['content-type']).to.eql('text/plain; charset=utf-8');
                if (expectedStatusCode === 500) {
                    expect(requestError).to.have.own.property('message');
                    expect(failedRequest).to.have.own.property('url');
                } else {
                    expect(requestError).to.eql(null);
                    expect(failedRequest).to.eql(null);
                }
                return response;
            })
                .finally(() => {
                    mainProxyServer.removeListener('requestFailed', onRequestFailed);
                });
        };

        // Replacement for it() that checks whether the tests really called the main and upstream proxies
        // Only use this for requests that are supposed to go through, e.g. not invalid credentials
        // eslint-disable-next-line no-underscore-dangle
        const _it = (description, func) => {
            it(description, () => {
                const upstreamCount = upstreamProxyRequestCount;
                const mainCount = mainProxyServer ? mainProxyServer.stats.connectRequestCount + mainProxyServer.stats.httpRequestCount : null;
                return func()
                    .then(() => {
                        if (useMainProxy) {
                            expect(mainCount).to.be.below(mainProxyServer.stats.connectRequestCount + mainProxyServer.stats.httpRequestCount);
                        }

                        if (useUpstreamProxy) {
                            expect(upstreamCount).to.be.below(upstreamProxyRequestCount);
                        }
                    });
            });
        };

        if (useUpstreamProxy) {
            _it('upstream ipv6', async () => {
                upstreamProxyHostname = '[::1]';
                const opts = getRequestOpts('/hello-world');

                try {
                    const response = await requestPromised(opts);

                    expect(response.body).to.eql('Hello world!');
                    expect(response.statusCode).to.eql(200);
                } finally {
                    upstreamProxyHostname = '127.0.0.1';
                }
            });
        } else if (useMainProxy && process.versions.node.split('.')[0] >= 15) {
            // Version check is required because HTTP/2 negotiation
            // is not supported on Node.js < 15.

            _it('direct ipv6', async () => {
                const opts = getRequestOpts('/hello-world');
                opts.url = opts.url.replace('127.0.0.1', '[::1]');

                // `request` proxy implementation fails to normalize IPv6.
                // `got-scraping` normalizes IPv6 properly.
                const response = await gotScraping({
                    url: opts.url,
                    headers: opts.headers,
                    timeout: {
                        request: opts.timeout,
                    },
                    proxyUrl: opts.proxy,
                    https: {
                        key: opts.key,
                    },
                });

                expect(response.body).to.eql('Hello world!');
                expect(response.statusCode).to.eql(200);
            });
        } else if (!useSsl && process.versions.node.split('.')[0] >= 15) {
            // Version check is required because HTTP/2 negotiation
            // is not supported on Node.js < 15.

            _it('forward ipv6', async () => {
                const opts = getRequestOpts('/hello-world');
                opts.url = opts.url.replace('127.0.0.1', '[::1]');

                // `request` proxy implementation fails to normalize IPv6.
                // `got-scraping` normalizes IPv6 properly.
                const response = await gotScraping({
                    url: opts.url,
                    headers: opts.headers,
                    timeout: {
                        request: opts.timeout,
                    },
                    proxyUrl: opts.proxy,
                    https: {
                        key: opts.key,
                    },
                });

                expect(response.body).to.eql('Hello world!');
                expect(response.statusCode).to.eql(200);
            });
        }

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
            _it('ignores non-standard server HTTP headers', () => {
                // Node 12+ uses a new HTTP parser (https://llhttp.org/),
                // which throws error on HTTP headers values with invalid chars.
                // So we skip this test for Node 12+.
                // Note that after Node.js introduced a stricter HTTP parsing as a security hotfix
                // (https://snyk.io/blog/node-js-release-fixes-a-critical-http-security-vulnerability/)
                // this test broke down so we had to add NODE_OPTIONS=--insecure-http-parser to "npm test" command
                const nodeMajorVersion = parseInt(process.versions.node.split('.')[0], 10);
                const skipInvalidHeaderValue = nodeMajorVersion >= 12;

                const opts = getRequestOpts(`/get-non-standard-headers?skipInvalidHeaderValue=${skipInvalidHeaderValue ? '1' : '0'}`);
                opts.method = 'GET';
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.body).to.eql('Hello sir!');
                        expect(response.statusCode).to.eql(200);
                        expect(response.headers).to.be.an('object');

                        // The server returns three headers:
                        //  'Invalid Header With Space': 'HeaderValue1',
                        //  'X-Normal-Header': 'HeaderValue2',
                        //  'Invalid-Header-Value': 'some\value',
                        // With HTTP proxy, the invalid headers should be removed, otherwise they should be present
                        expect(response.headers['x-normal-header']).to.eql('HeaderValue2');
                        if (useMainProxy && !useSsl) {
                            expect(response.headers['invalid header with space']).to.eql(undefined);
                            expect(response.headers['invalid-header-value']).to.eql(undefined);
                        } else {
                            expect(response.headers['invalid header with space']).to.eql('HeaderValue1');
                            expect(response.headers['invalid-header-value']).to.eql(skipInvalidHeaderValue ? undefined : 'some\value');
                        }
                    });
            });

            if (!useSsl) {
                _it('gracefully fails on invalid HTTP status code', () => {
                    const opts = getRequestOpts('/get-invalid-status-code');
                    opts.method = 'GET';
                    return requestPromised(opts)
                        .then((response) => {
                            if (useMainProxy) {
                                expect(response.statusCode).to.eql(502);
                                expect(response.body).to.eql('Bad status!');
                            } else {
                                expect(response.statusCode).to.eql(55);
                                expect(response.body).to.eql('Bad status!');
                            }
                        });
                });
            }
        }

        _it('save repeating server HTTP headers', () => {
            const opts = getRequestOpts('/get-repeating-headers');
            opts.method = 'GET';
            return requestPromised(opts)
                .then((response) => {
                    expect(response.body).to.eql('Hooray!');
                    expect(response.statusCode).to.eql(200);
                    expect(response.headers).to.be.an('object');

                    expect(response.headers['repeating-header']).to.eql('HeaderValue1, HeaderValue2');
                });
        });

        if (!useSsl) {
            _it('handles double Host header', () => {
                // This is a regression test, duplication of Host headers caused the proxy to throw
                // "TypeError: hostHeader.startsWith is not a function"
                // The only way to test this is to send raw HTTP request via TCP socket.
                return new Promise((resolve, reject) => {
                    let port;
                    let httpMsg;
                    if (useMainProxy) {
                        port = mainProxyServerPort;
                        httpMsg = `GET http://localhost:${targetServerPort}/echo-raw-headers HTTP/1.1\r\n`
                            + 'Host: dummy1.example.com\r\n'
                            + 'Host: dummy2.example.com\r\n';
                        if (mainProxyAuth) {
                            const auth = Buffer.from(`${mainProxyAuth.username}:${mainProxyAuth.password}`).toString('base64');
                            httpMsg += `Proxy-Authorization: Basic ${auth}\r\n`;
                        }
                        httpMsg += '\r\n';
                    } else {
                        port = targetServerPort;
                        httpMsg = 'GET /echo-raw-headers HTTP/1.1\r\n'
                            + 'Host: dummy1.example.com\r\n'
                            + 'Host: dummy2.example.com\r\n\r\n';
                    }

                    const client = net.createConnection({ port }, () => {
                        // console.log('connected to server! sending msg: ' + httpMsg);
                        client.write(httpMsg);
                    });
                    client.on('data', (data) => {
                        // console.log('received data: ' + data.toString());
                        try {
                            expect(data.toString()).to.match(/^HTTP\/1\.1 200 OK/);
                            client.end();
                        } catch (err) {
                            reject(err);
                        }
                    });
                    client.on('end', () => {
                        // console.log('disconnected from server');
                        resolve();
                    });
                    client.on('error', reject);
                });
            });
        }

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
                        clearInterval(intervalId);
                        return;
                    }
                    passThrough.write(DATA_CHUNKS[chunkIndex++], (err) => {
                        if (err) {
                            clearInterval(intervalId);
                            reject(err);
                        }
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
                        const lastConnectionId = sortedIds[sortedIds.length - 1];
                        const stats = mainProxyServer.getConnectionStats(Number(lastConnectionId))
                            || mainProxyServerConnectionId2Stats[lastConnectionId];

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
                    // Then test valid ones (passed as they are)
                    const opts = getRequestOpts('/basic-auth');
                    opts.url = opts.url.replace('://', '://john.doe$:Passwd$@');
                    return requestPromised(opts);
                })
                .then((response) => {
                    expect(response.body).to.eql('OK');
                    expect(response.statusCode).to.eql(200);
                })
                .then(() => {
                    // Then test URI encoded characters (must also work)
                    const opts = getRequestOpts('/basic-auth');
                    opts.url = opts.url.replace('://', '://john.doe%24:Passwd%24@');
                    return requestPromised(opts);
                })
                .then((response) => {
                    expect(response.body).to.eql('OK');
                    expect(response.statusCode).to.eql(200);
                });
        });

        // NOTE: PhantomJS cannot handle proxy auth with empty user or password, both need to be present!
        if (!mainProxyAuth || (mainProxyAuth.username && mainProxyAuth.password)) {
            _it('handles GET request from PhantomJS', async () => {
                // NOTE: use other hostname than 'localhost' or '127.0.0.1' otherwise PhantomJS would skip the proxy!
                const phantomUrl = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                const response = await phantomGet(phantomUrl, mainProxyUrl);
                expect(response).to.contain('Hello world!');
            });
        }

        if (!useSsl && mainProxyAuth && mainProxyAuth.username && mainProxyAuth.password) {
            it('handles GET request from PhantomJS with invalid credentials', async () => {
                // NOTE: use other hostname than 'localhost' or '127.0.0.1' otherwise PhantomJS would skip the proxy!
                const phantomUrl = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                const response = await phantomGet(phantomUrl, `http://bad:password@127.0.0.1:${mainProxyServerPort}`);
                expect(response).to.contain('Proxy credentials required');
            });
        }

        // Test also curl, to see how other HTTP clients do
        // NOTE: curl doesn't support auth without username with only password
        if (!mainProxyAuth || mainProxyAuth.username) {
            _it('handles GET request from curl', async () => {
                const curlUrl = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                const output = await curlGet(curlUrl, mainProxyUrl, true);
                expect(output).to.contain('Hello world!');
            });
        }

        if (mainProxyAuth && mainProxyAuth.username) {
            it('handles GET request from curl with invalid credentials', async () => {
                const curlUrl = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                // For SSL, we need to return curl's stderr to check what kind of error was there
                const output = await curlGet(curlUrl, `http://bad:password@127.0.0.1:${mainProxyServerPort}`, !useSsl);
                if (useSsl) {
                    expect(output).to.contain('Received HTTP code 407 from proxy after CONNECT');
                } else {
                    expect(output).to.contain('Proxy credentials required');
                }
            });
        }

        const testWsCall = () => {
            return new Promise((resolve, reject) => {
                const wsUrl = `${useSsl ? 'wss' : 'ws'}://127.0.0.1:${targetServerPort}`;
                const ws = new WebSocket.Client(wsUrl, [], {
                    proxy: {
                        origin: mainProxyUrl,
                        tls: useSsl ? { cert: sslCrt } : null,
                    },
                });

                ws.on('error', (err) => {
                    ws.close();
                    reject(err);
                });
                ws.on('open', () => {
                    ws.send('hello world');
                });
                ws.on('message', (event) => {
                    ws.close();
                    resolve(event.data);
                });
            })
                .then((data) => {
                    expect(data).to.eql('I received: hello world');
                });
        };

        _it('handles web socket connection', () => {
            return testWsCall(false);
        });

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
                opts.headers.TE = 'MyTest';
                return requestPromised(opts)
                    .then((response) => {
                        expect(response.statusCode).to.eql(200);
                        expect(response.headers['content-type']).to.eql('application/json');
                        const req = JSON.parse(response.body);
                        expect(req.headers['x-test-header']).to.eql('my-test-value');
                        expect(req.headers.te).to.eql(useSsl ? 'MyTest' : undefined);
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
                            const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-throw.gov`);
                            return testForErrorResponse(opts, 500);
                        })
                        .then(() => {
                            const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-promise.gov`);
                            return testForErrorResponse(opts, 500);
                        })
                        .then(() => {
                            const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-throw-known.gov`);
                            return testForErrorResponse(opts, 501);
                        })
                        .then(() => {
                            const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-promise-known.gov`);
                            return testForErrorResponse(opts, 501);
                        });
                });
            }

            if (useUpstreamProxy) {
                it('fails gracefully on invalid upstream proxy scheme', () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-scheme.gov`);
                    return testForErrorResponse(opts, 500);
                });

                it('fails gracefully on invalid upstream proxy URL', () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-url.gov`);
                    return testForErrorResponse(opts, 500);
                });

                it('fails gracefully on invalid upstream proxy username', async () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-username`);

                    if (useSsl) {
                        try {
                            await requestPromised(opts);
                            expect(false).to.be.eql(true);
                        } catch (error) {
                            expect(error.message).to.be.eql('tunneling socket could not be established, statusCode=502');
                        }
                    } else {
                        const response = await requestPromised(opts);

                        expect(response.statusCode).to.be.eql(502);
                        expect(response.body).to.be.eql('Invalid colon in username in upstream proxy credentials');
                    }
                });

                it('fails gracefully on non-existent upstream proxy host', () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-unknown-upstream-proxy-host.gov`);
                    return testForErrorResponse(opts, 502);
                });

                if (upstreamProxyAuth) {
                    _it('fails gracefully on bad upstream proxy credentials', () => {
                        const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-bad-upstream-proxy-credentials.gov`);
                        return testForErrorResponse(opts, 502);
                    });
                }
            }

            if (testCustomResponse) {
                if (!useSsl) {
                    it('supports custom response - simple', () => {
                        const opts = getRequestOpts('http://test-custom-response-simple.gov/some/path');
                        return requestPromised(opts)
                            .then((response) => {
                                expect(response.statusCode).to.eql(200);
                                expect(response.body).to.eql('TEST CUSTOM RESPONSE SIMPLE');
                            });
                    });

                    it('supports custom response - complex', () => {
                        const opts = getRequestOpts('http://test-custom-response-complex.gov:1234/some/path?query=456');
                        return requestPromised(opts)
                            .then((response) => {
                                expect(response.statusCode).to.eql(201);
                                expect(response.headers).to.deep.include({
                                    'my-test-header1': 'bla bla bla',
                                    'my-test-header2': 'bla bla bla2',
                                });
                                expect(response.body).to.eql('TEST CUSTOM RESPONSE COMPLEX');
                            });
                    });

                    it('supports custom response - long', () => {
                        const opts = getRequestOpts('http://test-custom-response-long.gov');
                        return requestPromised(opts)
                            .then((response) => {
                                expect(response.statusCode).to.eql(200);
                                expect(response.headers['content-length']).to.eql('5000000');
                                expect(response.body.length).to.eql(5000000);
                                expect(response.body).to.eql('X'.repeat(5000000));
                            });
                    });

                    it('supports custom response - promised', () => {
                        const opts = getRequestOpts('http://test-custom-response-promised.gov/some/path');
                        return requestPromised(opts)
                            .then((response) => {
                                expect(response.statusCode).to.eql(200);
                                expect(response.body).to.eql('TEST CUSTOM RESPONSE PROMISED');
                            });
                    });

                    it('fails on invalid custom response function', () => {
                        const opts = getRequestOpts('http://test-custom-response-invalid.gov');
                        return testForErrorResponse(opts, 500);
                    });
                } else {
                    it('does not support custom response in SSL mode', () => {
                        const opts = getRequestOpts('https://test-custom-response-simple.gov/some/path');
                        return testForErrorResponse(opts, 500);
                    });
                }
            }
        }

        after(function () {
            this.timeout(3 * 1000);
            return wait(1000)
                .then(() => {
                    // Ensure all handlers are removed
                    if (mainProxyServer) {
                        expect(mainProxyServer.getConnectionIds()).to.be.deep.eql([]);
                    }
                    expect(mainProxyServerConnectionIds).to.be.deep.eql([]);

                    const closedSomeConnectionsTwice = mainProxyServerConnectionsClosed
                        .reduce((duplicateConnections, id, index) => {
                            if (index > 0 && mainProxyServerConnectionsClosed[index - 1] === id) {
                                duplicateConnections.push(id);
                            }
                            return duplicateConnections;
                        }, []);

                    expect(closedSomeConnectionsTwice).to.be.deep.eql([]);
                    if (mainProxyServerStatisticsInterval) clearInterval(mainProxyServerStatisticsInterval);
                    if (mainProxyServer) {
                        // NOTE: we need to forcibly close pending connections,
                        // because e.g. on 502 errors in HTTPS mode, the request library
                        // doesn't close the connection and this would timeout
                        return mainProxyServer.close(true);
                    }
                })
                .then(() => {
                    if (upstreamProxyServer) {
                        // NOTE: We used to wait for upstream proxy connections to close,
                        // but for HTTPS, in Node 10+, they linger for some reason...
                        // return util.promisify(upstreamProxyServer.close).bind(upstreamProxyServer)();
                        upstreamProxyServer.close();
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

describe('Test 0 port option', async () => {
    it('Port inherits net port', async () => {
        for (let i = 0; i < 10; i++) {
            const server = new Server({
                port: 0,
            });
            // eslint-disable-next-line no-await-in-loop
            await server.listen();
            expect(server.port).to.be.eql(server.server.address().port);
            server.close(true);
        }
    });
});

describe(`Test ${LOCALHOST_TEST} setup`, () => {
    it('works', () => {
        return util.promisify(dns.lookup).bind(dns)(LOCALHOST_TEST, { family: 4 })
            .then(({ address, family }) => {
                // If this fails, see README.md !!!
                expect(address).to.eql('127.0.0.1');
                expect(family).to.eql(4);
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

describe('non-200 upstream connect response', () => {
    // No assertion planning :(
    // https://github.com/chaijs/chai/issues/670
    let success = false;

    after(() => {
        if (!success) {
            throw new Error('Failed');
        }
    });

    it('fails downstream with 502', (done) => {
        const server = http.createServer();
        server.on('connect', (_request, socket) => {
            socket.once('error', () => {});
            socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 1\r\n\r\na');
        });
        server.listen(() => {
            const serverPort = server.address().port;
            const proxyServer = new ProxyChain.Server({
                port: 0,
                prepareRequestFunction: () => {
                    return {
                        upstreamProxyUrl: `http://localhost:${serverPort}`,
                    };
                },
            });
            proxyServer.listen(() => {
                const proxyServerPort = proxyServer.port;

                const req = http.request({
                    method: 'CONNECT',
                    host: 'localhost',
                    port: proxyServerPort,
                    path: 'example.com:443',
                    headers: {
                        host: 'example.com:443',
                    },
                });
                req.once('connect', (response, socket, head) => {
                    expect(response.statusCode).to.equal(502);
                    expect(head.length).to.equal(0);
                    success = true;

                    socket.once('close', () => {
                        proxyServer.close();
                        server.close();

                        done();
                    });
                });

                req.end();
            });
        });
    });
});

it('supports localAddress', async () => {
    const target = http.createServer((serverRequest, serverResponse) => {
        serverResponse.end(serverRequest.socket.remoteAddress);
    });

    await util.promisify(target.listen.bind(target))(0);

    const server = new Server({
        port: 0,
        prepareRequestFunction: () => {
            return {
                localAddress: '127.0.0.2',
            };
        },
    });

    await server.listen();

    const response = await requestPromised({
        url: `http://127.0.0.1:${target.address().port}`,
        proxy: `http://127.0.0.2:${server.port}`,
    });

    try {
        expect(response.body).to.be.equal('::ffff:127.0.0.2');
    } finally {
        await server.close();
        await util.promisify(target.close.bind(target))();
    }
});

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
    // Test special chars, note that we URI-encode just username when constructing the proxyUrl,
    // to test both correctly and incorrectly encoded auth
    { type: 'Basic', username: 'us%erB', password: 'p$as%sA' },
];

useSslVariants.forEach((useSsl) => {
    mainProxyAuthVariants.forEach((mainProxyAuth) => {
        const baseDesc = `Server (${useSsl ? 'HTTPS' : 'HTTP'} -> Main proxy`;

        // Test custom response separately (it doesn't use upstream proxies)
        describe(`${baseDesc} -> Target + custom responses)`, createTestSuite({
            useMainProxy: true,
            useSsl,
            mainProxyAuth,
            testCustomResponse: true,
        }));

        useUpstreamProxyVariants.forEach((useUpstreamProxy) => {
            // If useUpstreamProxy is not used, only try one variant of upstreamProxyAuth
            let variants = upstreamProxyAuthVariants;
            if (!useUpstreamProxy) variants = [null];

            variants.forEach((upstreamProxyAuth) => {
                let desc = `${baseDesc} `;

                if (mainProxyAuth) {
                    if (!mainProxyAuth) desc += 'public ';
                    else if (mainProxyAuth.username && mainProxyAuth.password) desc += 'with username:password ';
                    else if (mainProxyAuth.username) desc += 'with username only ';
                    else desc += 'with password only ';
                }
                if (useUpstreamProxy) {
                    desc += '-> Upstream proxy ';
                    if (!upstreamProxyAuth) desc += 'public ';
                    else if (upstreamProxyAuth.username && upstreamProxyAuth.password) desc += 'with username:password ';
                    else if (upstreamProxyAuth.username) desc += 'with username only ';
                    else desc += 'with password only ';
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
