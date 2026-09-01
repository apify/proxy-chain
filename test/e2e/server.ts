import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import stream from 'node:stream';
import tls from 'node:tls';
import util from 'node:util';
import zlib from 'node:zlib';

import portastic from 'portastic';
import { createProxy, type ProxyServer } from 'proxy';
import type { Browser, LaunchOptions, PuppeteerNode } from 'puppeteer';
import { WebSocket } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ConnectionStats, HttpServerOptions, PrepareRequestFunction, PrepareRequestFunctionResult, ServerOptions,
} from '../../src/index.js';
import { RequestError, Server } from '../../src/index.js';
import { parseAuthorizationHeader } from '../../src/utils/parse_authorization_header.js';
import { expectProxyTunnelError } from '../utils/http_assertions.js';
import { createDispatcher, httpRequest, type HttpRequestOpts, type HttpResponse } from '../utils/http_client.js';
import { PORT_RANGES } from '../utils/port_ranges.js';
import { TargetServer } from '../utils/target_server.js';
import { closeServer, getServerPort, listenOnPort, takePort, wait } from '../utils/test_helpers.js';

/*
TODO - add following tests:
- gzip Content-Encoding
- IPv6 !!!
- raw TCP connection over proxy
- HandlerForward when connected through shader proxy threw error if source socket was closed instead of response, test why.
*/

// See README.md for details
const LOCALHOST_TEST = 'localhost-test';

const sslKey = fs.readFileSync(path.join(import.meta.dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(import.meta.dirname, 'ssl.crt'));

// Enable self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NON_EXISTENT_HOSTNAME = 'this-apify-hostname-is-surely-non-existent.cz';

// Prepare testing data
const DATA_CHUNKS: string[] = [];
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

// Chromium occasionally fails to spawn under headless Docker (dbus/crashpad noise + ENOENT-ish exits).
// Retry briefly so a single flaky launch doesn't fail the whole suite.
const launchPuppeteer = async (
    puppeteer: PuppeteerNode,
    launchOpts: LaunchOptions,
): Promise<Browser> => {
    const MAX_ATTEMPTS = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await puppeteer.launch(launchOpts);
        } catch (error) {
            lastError = error;
            if (attempt === MAX_ATTEMPTS) break;
            await wait(500 * attempt);
        }
    }
    throw lastError;
};

// Opens web page in puppeteer and returns the HTML content
const puppeteerGet = async (url: string, proxyUrl?: string): Promise<string> => {
    const { default: puppeteer } = await import('puppeteer');

    const parsed = proxyUrl ? new URL(proxyUrl) : undefined;

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
    ];

    const launchOpts: LaunchOptions = {
        acceptInsecureCerts: true,
        headless: true,
        args,
    };

    if (parsed) {
        if (parsed.protocol === 'https:') {
            args.push(`--proxy-server=${parsed.origin}`);
            // For HTTPS proxies with self-signed certificates,
            // ignore certificate errors on the proxy connection itself.
            args.push('--ignore-certificate-errors');
        } else {
            launchOpts.env = {
                HTTP_PROXY: parsed.origin,
            };
        }
    }

    const browser = await launchPuppeteer(puppeteer, launchOpts);

    try {
        const page = await browser.newPage();

        if (parsed) {
            await page.authenticate({
                username: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password),
            });
        }

        const response = await page.goto(url);
        if (response === null) throw new Error(`Navigation to ${url} produced no response.`);
        const text = await response.text();

        return text;
    } finally {
        await browser.close();
    }
};

// Opens web page in curl and returns the HTML content.
// The thing is, on error curl closes the connection immediately, which used to cause
// uncaught ECONNRESET error. See https://github.com/apify/proxy-chain/issues/53
// This is a regression test for that situation
const curlGet = async (url: string, proxyUrl?: string, returnResponse?: boolean): Promise<string> => {
    let cmd = 'curl --insecure '; // ignore SSL errors
    if (proxyUrl) {
        if (proxyUrl.startsWith('https://')) {
            cmd += '--proxy-insecure ';
        }
        cmd += `-x ${proxyUrl} `; // use proxy
    }
    if (returnResponse) cmd += `--silent --show-error --output - ${url}`; // print response to stdout
    else cmd += `${url}`;
    // console.log(`curlGet(): ${cmd}`);

    return await new Promise<string>((resolve) => {
        childProcess.exec(cmd, (_error, stdout, stderr) => {
            // NOTE: It's okay if curl exits with non-zero code, that happens e.g. on 407 error over HTTPS
            resolve(stderr || stdout);
        });
    });
};

const requestUrl = (proxiedRequest: http.IncomingMessage): string => {
    if (proxiedRequest.url === undefined) throw new Error('The proxied request carried no URL.');
    return proxiedRequest.url;
};

const NODE_MAJOR_VERSION = parseInt(process.versions.node.split('.')[0], 10);

const TEST_SUITE_TIMEOUT_MILLIS = 30_000;

type ProxyAuth = { username: string; password: string };
type UpstreamProxyAuth = ProxyAuth & { type: string };

type TestSuiteConfig = {
    useSsl?: boolean;
    useMainProxy?: boolean;
    mainProxyAuth?: ProxyAuth | null;
    mainProxyServerType?: 'http' | 'https';
    useUpstreamProxy?: boolean;
    upstreamProxyAuth?: UpstreamProxyAuth | null;
    testCustomResponse?: boolean;
};

/**
 * This function creates a function to test the proxy, with specific configuration options.
 * This is to avoid duplication of the code, since many of the tests are same for the specific configurations.
 * @return {function(...[*]=)}
 */
const createTestSuite = ({
    useSsl, useMainProxy, mainProxyAuth, mainProxyServerType, useUpstreamProxy, upstreamProxyAuth, testCustomResponse,
}: TestSuiteConfig) => {
    return () => {
        let freePorts: number[];

        let targetServerPort: number;
        let targetServer: TargetServer;

        let upstreamProxyServer: http.Server | undefined;
        let upstreamProxyPort: number;
        let upstreamProxyRequestCount = 0;

        let mainProxyServer: Server | undefined;
        let mainProxyServerStatisticsInterval: NodeJS.Timeout | undefined;
        const mainProxyServerConnections: Record<number, { groups: string[]; token: string; hostname: string }> = {};
        let mainProxyServerPort: number;
        const mainProxyServerConnectionIds: number[] = [];
        const mainProxyServerConnectionsClosed: number[] = [];
        const mainProxyServerConnectionId2Stats: Record<number, ConnectionStats> = {};

        let upstreamProxyHostname = '127.0.0.1';

        let baseUrl: string;
        let mainProxyUrl: string | undefined;
        const getRequestOpts = (pathOrUrl: string): HttpRequestOpts & { headers: Record<string, string> } => {
            return {
                url: pathOrUrl[0] === '/' ? `${baseUrl}${pathOrUrl}` : pathOrUrl,
                proxyUrl: mainProxyUrl,
                headers: {
                    // Node.js 20+ enables HTTP keep-alive by default, which causes connection
                    // reuse between tests and breaks connection tracking. Force close.
                    Connection: 'close',
                },
                timeoutMillis: 30000,
                ignoreCertificateErrors: true,
            };
        };

        let counter = 0;

        beforeAll(async () => {
            return portastic.find(PORT_RANGES.server).then(async (ports) => {
                freePorts = ports;

                // Setup target HTTP server
                targetServerPort = takePort(freePorts);
                targetServer = new TargetServer({
                    port: targetServerPort, useSsl, sslKey, sslCrt,
                });
                return targetServer.listen();
            }).then(async () => {
                // Setup proxy chain server
                if (useUpstreamProxy) {
                    return new Promise<void>((resolve, reject) => {
                        const upstreamProxyHttpServer: ProxyServer = http.createServer();

                        // Node.js 20+ enables HTTP keep-alive by default, which causes connection
                        // tracking issues in tests. Disable keep-alive on the upstream proxy server.
                        upstreamProxyHttpServer.keepAliveTimeout = 0;

                        // Setup upstream proxy authorization
                        upstreamProxyHttpServer.authenticate = function (req) {
                            upstreamProxyRequestCount++;

                            // Special case: no authentication required
                            if (!upstreamProxyAuth) return true;

                            // parse the "Proxy-Authorization" header
                            const auth = req.headers['proxy-authorization'];
                            if (!auth) return false;

                            const parsed = parseAuthorizationHeader(auth);
                            // A header that parses to null (e.g. whitespace only) simply does not match.
                            const authKeys = ['type', 'username', 'password'] as const;
                            return parsed !== null && authKeys.every((name) => parsed[name] === upstreamProxyAuth[name]);
                        };

                        upstreamProxyHttpServer.on('error', (err) => {
                            console.dir(err);
                            throw new Error('Upstream proxy HTTP server failed');
                        });

                        upstreamProxyPort = takePort(freePorts);
                        upstreamProxyServer = createProxy(upstreamProxyHttpServer);
                        listenOnPort(upstreamProxyServer, upstreamProxyPort).then(() => resolve(), reject);
                    });
                }
            }).then(async () => {
                // Setup main proxy server
                if (useMainProxy) {
                    mainProxyServerPort = takePort(freePorts);

                    const prepareRequestFunction: PrepareRequestFunction = ({
                        request: proxiedRequest, username, password, hostname, port, connectionId,
                    }): PrepareRequestFunctionResult | Promise<PrepareRequestFunctionResult> => {
                        const result: PrepareRequestFunctionResult = {
                            requestAuthentication: false,
                            upstreamProxyUrl: null,
                        };
                        // If prepareRequestFunction() will cause error, don't add to this test array as it will fail in afterAll()
                        let addToMainProxyServerConnectionIds = true;

                        expect(proxiedRequest).toBeTypeOf('object');
                        expect(port).toBeTypeOf('number');

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

                        if (hostname === 'test-custom-response-buffer.gov') {
                            result.customResponseFunction = () => {
                                return {
                                    statusCode: 200,
                                    headers: {
                                        'content-encoding': 'gzip',
                                    },
                                    body: zlib.gzipSync('Hello, world!'),
                                };
                            };
                        }

                        if (hostname === 'test-custom-response-simple.gov') {
                            result.customResponseFunction = () => {
                                const trgParsed = new URL(requestUrl(proxiedRequest));
                                expect(trgParsed.host).toBe(hostname);
                                expect(trgParsed.pathname).toBe('/some/path');
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
                                const trgParsed = new URL(requestUrl(proxiedRequest));
                                expect(trgParsed.hostname).toBe(hostname);
                                expect(trgParsed.pathname).toBe('/some/path');
                                expect(trgParsed.search).toBe('?query=456');
                                expect(port).toBe(1234);
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
                                const trgParsed = new URL(requestUrl(proxiedRequest));
                                expect(trgParsed.host).toBe(hostname);
                                expect(trgParsed.pathname).toBe('/');
                                return {
                                    body: 'X'.repeat(5000000),
                                };
                            };
                        }

                        if (hostname === 'test-custom-response-promised.gov') {
                            result.customResponseFunction = async () => {
                                const trgParsed = new URL(requestUrl(proxiedRequest));
                                expect(trgParsed.host).toBe(hostname);
                                expect(trgParsed.pathname).toBe('/some/path');
                                return Promise.resolve().then(() => {
                                    return {
                                        body: 'TEST CUSTOM RESPONSE PROMISED',
                                    };
                                });
                            };
                        }

                        if (hostname === 'test-custom-response-invalid.gov') {
                            // @ts-expect-error - deliberately not a function; the server must reject it at runtime.
                            result.customResponseFunction = 'THIS IS NOT A FUNCTION';
                            addToMainProxyServerConnectionIds = false;
                        }

                        if (mainProxyAuth) {
                            const authDoesNotMatch = mainProxyAuth.username !== username || mainProxyAuth.password !== password;
                            const nopassword = username === 'nopassword' && password === '';
                            if (authDoesNotMatch && !nopassword) {
                                result.requestAuthentication = true;
                                addToMainProxyServerConnectionIds = false;
                                // Now that authentication is requested, upstream proxy should not get used,
                                // so try some invalid one and it should cause no issue
                                result.upstreamProxyUrl = 'http://dummy-hostname-xyz.gov:6789';
                            }
                        }

                        if (useUpstreamProxy && !result.upstreamProxyUrl) {
                            let upstreamProxyUrl: string;

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

                    const httpOpts: HttpServerOptions = {
                        port: mainProxyServerPort,
                        // verbose: true, // Enable this if you want verbose logs
                    };

                    if (mainProxyAuth || useUpstreamProxy || testCustomResponse) {
                        httpOpts.prepareRequestFunction = prepareRequestFunction;
                    }

                    httpOpts.authRealm = AUTH_REALM;

                    // Configure HTTPS proxy server if requested.
                    const opts: ServerOptions = mainProxyServerType === 'https'
                        ? { ...httpOpts, serverType: 'https', httpsOptions: { key: sslKey, cert: sslCrt } }
                        : httpOpts;

                    mainProxyServer = new Server(opts);

                    // Node.js 20+ enables HTTP keep-alive by default, which causes connection
                    // tracking issues in tests. Disable keep-alive on the proxy server.
                    mainProxyServer.server.keepAliveTimeout = 0;

                    mainProxyServer.on('connectionClosed', ({ connectionId, stats }: { connectionId: number; stats: ConnectionStats }) => {
                        expect(mainProxyServer!.getConnectionIds()).toContain(connectionId);
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
                        expect(mainProxyServer.port).toBe(mainProxyServerPort);
                        expect(getServerPort(mainProxyServer.server)).toBe(mainProxyServerPort);
                    }

                    if (useMainProxy) {
                        let auth = '';
                        if (mainProxyAuth) auth = `${mainProxyAuth.username}:${mainProxyAuth.password}@`;
                        const proxySchema = mainProxyServerType === 'https' ? 'https' : 'http';
                        mainProxyUrl = `${proxySchema}://${auth}127.0.0.1:${mainProxyServerPort}`;
                    }
                });
        }, TEST_SUITE_TIMEOUT_MILLIS);

        // Helper functions

        // Tests for 502 Bad gateway or 407 Proxy Authenticate
        // Returns the response only over plain HTTP; over HTTPS the request rejects instead.
        const testForErrorResponse = async (opts: HttpRequestOpts, expectedStatusCode: number): Promise<HttpResponse | undefined> => {
            let requestError: Error | null = null;
            let failedRequest: http.IncomingMessage | null = null;
            const onRequestFailed = ({ error, request: failed }: { error: Error; request: http.IncomingMessage }) => {
                requestError = error;
                failedRequest = failed;
            };

            mainProxyServer!.on('requestFailed', onRequestFailed);

            const promise = httpRequest(opts);

            if (useSsl) {
                return expectProxyTunnelError(promise, expectedStatusCode)
                    .then(() => undefined)
                    .finally(() => {
                        mainProxyServer!.removeListener('requestFailed', onRequestFailed);
                    });
            }
            return promise.then((response) => {
                expect(response.statusCode).toBe(expectedStatusCode);
                expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
                if (expectedStatusCode === 500) {
                    expect(requestError).toHaveProperty('message');
                    expect(failedRequest).toHaveProperty('url');
                } else {
                    expect(requestError).toBe(null);
                    expect(failedRequest).toBe(null);
                }
                return response;
            })
                .finally(() => {
                    mainProxyServer!.removeListener('requestFailed', onRequestFailed);
                });
        };

        // Replacement for it() that checks whether the tests really called the main and upstream proxies
        // Only use this for requests that are supposed to go through, e.g. not invalid credentials
        // eslint-disable-next-line no-underscore-dangle
        const _it = (description: string, func: () => Promise<unknown>) => {
            it(description, async () => {
                const upstreamCount = upstreamProxyRequestCount;
                const mainCount = mainProxyServer
                    ? mainProxyServer.stats.connectRequestCount + mainProxyServer.stats.httpRequestCount
                    : null;
                return func()
                    .then(() => {
                        if (useMainProxy) {
                            expect(mainCount).toBeLessThan(mainProxyServer!.stats.connectRequestCount + mainProxyServer!.stats.httpRequestCount);
                        }

                        if (useUpstreamProxy) {
                            expect(upstreamCount).toBeLessThan(upstreamProxyRequestCount);
                        }
                    });
            });
        };

        if (useUpstreamProxy) {
            _it('upstream ipv6', async () => {
                upstreamProxyHostname = '[::1]';
                const opts = getRequestOpts('/hello-world');

                try {
                    const response = await httpRequest(opts);

                    expect(response.body).toBe('Hello world!');
                    expect(response.statusCode).toBe(200);
                } finally {
                    upstreamProxyHostname = '127.0.0.1';
                }
            });
        } else if (useMainProxy) {
            _it('direct ipv6', async () => {
                const opts = getRequestOpts('/hello-world');
                opts.url = opts.url.replace('127.0.0.1', '[::1]');

                const response = await httpRequest(opts);

                expect(response.body).toBe('Hello world!');
                expect(response.statusCode).toBe(200);
            });
        } else if (!useSsl) {
            _it('forward ipv6', async () => {
                const opts = getRequestOpts('/hello-world');
                opts.url = opts.url.replace('127.0.0.1', '[::1]');

                const response = await httpRequest(opts);

                expect(response.body).toBe('Hello world!');
                expect(response.statusCode).toBe(200);
            });
        }

        (['GET', 'POST', 'PUT', 'DELETE'] as const).forEach((method) => {
            _it(`handles simple ${method} request`, async () => {
                const opts = getRequestOpts('/hello-world');
                opts.method = method;
                return httpRequest(opts)
                    .then((response) => {
                        expect(response.body).toBe('Hello world!');
                        expect(response.statusCode).toBe(200);
                    });
            });
        });

        (['POST', 'PUT', 'PATCH'] as const).forEach((method) => {
            _it(`handles ${method} request with payload and passes Content-Type`, async () => {
                const opts = getRequestOpts('/echo-payload');
                opts.method = method;
                opts.body = 'SOME BODY LALALALA';
                opts.headers['Content-Type'] = 'text/my-test';
                return httpRequest(opts)
                    .then((response) => {
                        expect(response.body).toBe(opts.body);
                        expect(response.headers['content-type']).toBe(opts.headers['Content-Type']);
                        expect(response.statusCode).toBe(200);
                    });
            });
        });

        // NOTE: upstream proxy cannot handle non-standard headers
        // NOTE: Node.js 20+ has stricter HTTP client parsing that ignores --insecure-http-parser
        // for invalid header names (spaces) and invalid status codes, so we skip these tests.
        if (!useUpstreamProxy && NODE_MAJOR_VERSION < 20) {
            _it('ignores non-standard server HTTP headers', async () => {
                // Node 12+ uses a new HTTP parser (https://llhttp.org/),
                // which throws error on HTTP headers values with invalid chars.
                // So we skip this test for Node 12+.
                // Note that after Node.js introduced a stricter HTTP parsing as a security hotfix
                // (https://snyk.io/blog/node-js-release-fixes-a-critical-http-security-vulnerability/)
                // this test broke down so we had to run Node with --insecure-http-parser (set in vitest.config.ts).
                const skipInvalidHeaderValue = NODE_MAJOR_VERSION >= 12;

                const opts = getRequestOpts(`/get-non-standard-headers?skipInvalidHeaderValue=${skipInvalidHeaderValue ? '1' : '0'}`);
                opts.method = 'GET';
                return httpRequest(opts)
                    .then((response) => {
                        expect(response.body).toBe('Hello sir!');
                        expect(response.statusCode).toBe(200);
                        expect(response.headers).toBeTypeOf('object');

                        // The server returns three headers:
                        //  'Invalid Header With Space': 'HeaderValue1',
                        //  'X-Normal-Header': 'HeaderValue2',
                        //  'Invalid-Header-Value': 'some\value',
                        // With HTTP proxy, the invalid headers should be removed, otherwise they should be present
                        expect(response.headers['x-normal-header']).toBe('HeaderValue2');
                        if (useMainProxy && !useSsl) {
                            expect(response.headers['invalid header with space']).toBe(undefined);
                            expect(response.headers['invalid-header-value']).toBe(undefined);
                        } else {
                            expect(response.headers['invalid header with space']).toBe('HeaderValue1');
                            expect(response.headers['invalid-header-value']).toBe(skipInvalidHeaderValue ? undefined : 'some\value');
                        }
                    });
            });

            if (!useSsl) {
                _it('gracefully fails on invalid HTTP status code', async () => {
                    const opts = getRequestOpts('/get-invalid-status-code');
                    opts.method = 'GET';
                    return httpRequest(opts)
                        .then((response) => {
                            if (useMainProxy) {
                                expect(response.statusCode).toBe(592);
                                expect(response.body).toBe('Bad status!');
                            } else {
                                expect(response.statusCode).toBe(55);
                                expect(response.body).toBe('Bad status!');
                            }
                        });
                });
            }
        }

        _it('save repeating server HTTP headers', async () => {
            const opts = getRequestOpts('/get-repeating-headers');
            opts.method = 'GET';
            return httpRequest(opts)
                .then((response) => {
                    expect(response.body).toBe('Hooray!');
                    expect(response.statusCode).toBe(200);
                    expect(response.headers).toBeTypeOf('object');

                    expect(response.headers['repeating-header']).toBe('HeaderValue1, HeaderValue2');
                });
        });

        // TODO: investigate https case.
        if (!useSsl) {
            _it('handles double Host header', async () => {
                // This is a regression test, duplication of Host headers caused the proxy to throw
                // "TypeError: hostHeader.startsWith is not a function"
                // The only way to test this is to send raw HTTP request via TCP socket.
                return new Promise<void>((resolve, reject) => {
                    let port: number;
                    let httpMsg: string;
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

                    let client: net.Socket;
                    if (mainProxyServerType === 'https') {
                        const tlsClient = tls.connect({
                            port,
                            host: 'localhost',
                            rejectUnauthorized: false,
                        }, () => {
                            tlsClient.write(httpMsg);
                        });
                        client = tlsClient;
                    } else {
                        const netClient = net.createConnection({ port }, () => {
                            netClient.write(httpMsg);
                        });
                        client = netClient;
                    }

                    client.on('data', (data) => {
                        // console.log('received data: ' + data.toString());
                        try {
                            expect(data.toString()).toMatch(/^HTTP\/1\.1 200 OK/);
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

        _it('handles large streamed POST payload', async () => {
            const opts = getRequestOpts('/echo-payload');
            opts.headers['Content-Type'] = 'text/my-test';
            opts.method = 'POST';

            let chunkIndex = 0;
            const passThrough = new stream.PassThrough();
            opts.body = passThrough;

            const intervalId = setInterval(() => {
                if (chunkIndex >= DATA_CHUNKS.length) {
                    passThrough.end();
                    clearInterval(intervalId);
                    return;
                }
                passThrough.write(DATA_CHUNKS[chunkIndex++], (err) => {
                    if (err) {
                        clearInterval(intervalId);
                        passThrough.destroy(err);
                    }
                });
            }, 1);

            try {
                const response = await httpRequest(opts);
                expect(response.statusCode).toBe(200);
                expect(response.body).toBe(DATA_CHUNKS_COMBINED);
            } finally {
                clearInterval(intervalId);
            }
        });

        const test1MAChars = async () => {
            const opts = getRequestOpts('/get-1m-a-chars-together');
            opts.method = 'GET';
            return httpRequest(opts)
                .then((response) => {
                    expect(response.body).toMatch(/^a{1000000}$/);
                    expect(response.statusCode).toBe(200);
                    const expectedSize = 1000000; // "a" takes one byte, so one 1 milion "a" should be 1MB

                    // this condition is here because some tests do not use prepareRequestFunction
                    // and therefore are not trackable
                    if (mainProxyServerConnections && Object.keys(mainProxyServerConnections).length) {
                        const sortedIds = Object.keys(mainProxyServerConnections).sort((a, b) => {
                            if (Number(a) < Number(b)) return -1;
                            if (Number(a) > Number(b)) return 1;
                            return 0;
                        });
                        const lastConnectionId = Number(sortedIds[sortedIds.length - 1]);
                        const stats = mainProxyServer!.getConnectionStats(lastConnectionId)
                            || mainProxyServerConnectionId2Stats[lastConnectionId];

                        // 5% range because network negotiation adds to network trafic
                        const expectWithin5Percent = (value: number | null) => {
                            expect(value).toBeGreaterThanOrEqual(expectedSize);
                            expect(value).toBeLessThanOrEqual(expectedSize * 1.05);
                        };
                        expectWithin5Percent(stats.srcTxBytes);
                        expectWithin5Percent(stats.trgRxBytes);
                    }
                });
        };
        _it('handles large GET response', test1MAChars);

        // TODO: Test streamed GET
        // _it('handles large streamed GET response', test1MAChars);

        _it('handles 301 redirect', async () => {
            const opts = getRequestOpts('/redirect-to-hello-world');
            return httpRequest(opts)
                .then((response) => {
                    expect(response.body).toBe('Hello world!');
                    expect(response.statusCode).toBe(200);
                });
        });

        _it('handles basic authentication', async () => {
            return Promise.resolve()
                .then(async () => {
                    // First test invalid credentials
                    const opts = getRequestOpts('/basic-auth');
                    opts.url = opts.url.replace('://', '://invalid:password@');
                    return httpRequest(opts);
                })
                .then((response) => {
                    expect(response.body).toBe('Unauthorized');
                    expect(response.statusCode).toBe(401);
                })
                .then(async () => {
                    // Then test valid ones (passed as they are)
                    const opts = getRequestOpts('/basic-auth');
                    opts.url = opts.url.replace('://', '://john.doe$:Passwd$@');
                    return httpRequest(opts);
                })
                .then((response) => {
                    expect(response.body).toBe('OK');
                    expect(response.statusCode).toBe(200);
                })
                .then(async () => {
                    // Then test URI encoded characters (must also work)
                    const opts = getRequestOpts('/basic-auth');
                    opts.url = opts.url.replace('://', '://john.doe%24:Passwd%24@');
                    return httpRequest(opts);
                })
                .then((response) => {
                    expect(response.body).toBe('OK');
                    expect(response.statusCode).toBe(200);
                });
        });

        // Skip on Node 14: HTTPS proxy with upstream proxy causes EPIPE errors.
        const isNode14 = NODE_MAJOR_VERSION === 14;
        const skipPuppeteerOnNode14 = isNode14 && mainProxyServerType === 'https' && useUpstreamProxy && !mainProxyAuth;

        if ((!mainProxyAuth || (mainProxyAuth.username && mainProxyAuth.password)) && !skipPuppeteerOnNode14) {
            it('handles GET request using puppeteer', async () => {
                const targetUrl = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                const response = await puppeteerGet(targetUrl, mainProxyUrl);
                expect(response).toContain('Hello world!');
            });
        }

        if (!useSsl && mainProxyAuth && mainProxyAuth.username && mainProxyAuth.password) {
            it('handles GET request using puppeteer with invalid credentials', async () => {
                const targetUrl = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                const proxySchema = mainProxyServerType === 'https' ? 'https' : 'http';
                const response = await puppeteerGet(targetUrl, `${proxySchema}://bad:password@127.0.0.1:${mainProxyServerPort}`);
                expect(response).toContain('Proxy credentials required');
            });
        }

        // Test also curl, to see how other HTTP clients do
        // NOTE: curl doesn't support auth without username with only password
        if (!mainProxyAuth || mainProxyAuth.username) {
            _it('handles GET request from curl', async () => {
                const curlUrl = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                const output = await curlGet(curlUrl, mainProxyUrl, true);
                expect(output).toContain('Hello world!');
            });
        }

        if (mainProxyAuth && mainProxyAuth.username) {
            it('handles GET request from curl with invalid credentials', async () => {
                const curlUrl = `${useSsl ? 'https' : 'http'}://${LOCALHOST_TEST}:${targetServerPort}/hello-world`;
                const proxySchema = mainProxyServerType === 'https' ? 'https' : 'http';
                // For SSL, we need to return curl's stderr to check what kind of error was there
                const output = await curlGet(curlUrl, `${proxySchema}://bad:password@127.0.0.1:${mainProxyServerPort}`, !useSsl);
                if (useSsl) {
                    // The first alternative is the old wording, before dafdb20a26d0c890e83dea61a104b75408481ebd.
                    expect(output).toMatch(/Received HTTP code 407 from proxy after CONNECT|CONNECT tunnel failed, response 407/);
                } else {
                    expect(output).toContain('Proxy credentials required');
                }
            });
        }

        const testWsCall = async () => {
            const wsUrl = `${useSsl ? 'wss' : 'ws'}://127.0.0.1:${targetServerPort}`;
            const dispatcher = createDispatcher({
                url: wsUrl,
                proxyUrl: mainProxyUrl,
                ignoreCertificateErrors: true,
            });

            try {
                const data = await new Promise<string>((resolve, reject) => {
                    const ws = new WebSocket(wsUrl, { dispatcher });

                    ws.addEventListener('error', (event) => {
                        ws.close();
                        reject(new Error(`Web socket connection to ${wsUrl} failed.`, { cause: event.error }));
                    });
                    ws.addEventListener('open', () => {
                        ws.send('hello world');
                    });
                    ws.addEventListener('message', (event) => {
                        ws.close();
                        resolve(event.data as string);
                    });
                });

                expect(data).toBe('I received: hello world');
            } finally {
                await dispatcher.close();
            }
        };

        _it('handles web socket connection', async () => {
            return testWsCall();
        });

        if (useMainProxy) {
            if (!useUpstreamProxy) {
                _it(`handles malformed response`, async () => {
                    const server = net.createServer((socket) => {
                        socket.end(`HTTP/1.1 x \r\n\r\n`);
                    });

                    await new Promise<void>((resolve, reject) => {
                        server.once('error', reject);

                        server.listen(0, () => {
                            server.off('error', reject);
                            resolve();
                        });
                    });

                    const opts = getRequestOpts(`http://127.0.0.1:${getServerPort(server)}`);
                    return httpRequest(opts)
                        .then((response) => {
                            expect(response.statusCode).toBe(599);
                            server.close();
                        });
                });
            }

            it('handles invalid CONNECT path', async () => {
                const requestModule = mainProxyServerType === 'https' ? https : http;
                const req = requestModule.request(mainProxyUrl!, {
                    method: 'CONNECT',
                    path: ':443',
                    headers: {
                        host: ':443',
                    },
                    // Accept self-signed certificates for HTTPS proxy.
                    rejectUnauthorized: false,
                });

                const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
                    req.once('connect', (res, socket) => {
                        socket.destroy();
                        resolve(res);
                    });
                    req.once('error', reject);
                    req.end();
                });

                expect(response.statusCode).toBe(400);
            });

            _it('returns 404 for non-existent hostname', async () => {
                const opts = getRequestOpts(`http://${NON_EXISTENT_HOSTNAME}`);
                return httpRequest(opts)
                    .then((response) => {
                        expect(response.statusCode).toBe(404);
                    });
            });

            it('returns 400 for direct connection to main proxy', async () => {
                const opts = { url: mainProxyUrl! };
                return httpRequest(opts)
                    .then((response) => {
                        expect(response.statusCode).toBe(400);
                    });
            });

            _it('removes hop-by-hop headers (HTTP-only) and leaves other ones', async () => {
                const opts = getRequestOpts('/echo-request-info');
                opts.headers['X-Test-Header'] = 'my-test-value';
                opts.headers.TE = 'MyTest';
                return httpRequest(opts)
                    .then((response) => {
                        expect(response.statusCode).toBe(200);
                        expect(response.headers['content-type']).toBe('application/json');
                        const req = JSON.parse(response.body);
                        expect(req.headers['x-test-header']).toBe('my-test-value');
                        expect(req.headers.te).toBe(useSsl ? 'MyTest' : undefined);
                    });
            });

            if (mainProxyAuth) {
                it('implies username if colon missing', async () => {
                    const server = net.createServer((socket) => {
                        socket.end();
                    });

                    await new Promise<void>((resolve, reject) => {
                        server.once('error', reject);
                        server.listen(0, resolve);
                    });

                    try {
                        const proxyUrl = new URL(mainProxyUrl!);
                        const isHttpsProxy = proxyUrl.protocol === 'https:';
                        const requestModule = isHttpsProxy ? https : http;

                        const requestOpts: https.RequestOptions = {
                            hostname: proxyUrl.hostname,
                            port: proxyUrl.port,
                            method: 'CONNECT',
                            path: `127.0.0.1:${getServerPort(server)}`,
                            headers: {
                                host: `127.0.0.1:${getServerPort(server)}`,
                                'proxy-authorization': `Basic ${Buffer.from('nopassword').toString('base64')}`,
                            },
                        };

                        // Accept self-signed certificates for HTTPS proxy.
                        if (isHttpsProxy) {
                            requestOpts.rejectUnauthorized = false;
                        }

                        const req = requestModule.request(requestOpts);
                        const { response, socket, head } = await new Promise<{
                            response: http.IncomingMessage; socket: net.Socket; head: Buffer;
                        }>((resolve, reject) => {
                            req.once('connect', (res, sock, h) => resolve({ response: res, socket: sock, head: h }));
                            req.once('error', reject);
                            req.end();
                        });

                        expect(response.statusCode).toBe(200);
                        expect(head).toHaveLength(0);
                        socket.destroy();
                    } finally {
                        await closeServer(server);
                    }
                });

                it('returns 407 for invalid credentials', async () => {
                    const proxySchema = mainProxyServerType === 'https' ? 'https' : 'http';

                    return Promise.resolve()
                        .then(async () => {
                            // Test no username and password
                            const opts = getRequestOpts('/whatever');
                            opts.proxyUrl = `${proxySchema}://127.0.0.1:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(async () => {
                            // Test good username and invalid password
                            const opts = getRequestOpts('/whatever');
                            opts.proxyUrl = `${proxySchema}://${mainProxyAuth.username}:bad-password@127.0.0.1:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(async () => {
                            // Test invalid username and good password
                            const opts = getRequestOpts('/whatever');
                            opts.proxyUrl = `${proxySchema}://bad-username:${mainProxyAuth.password}@127.0.0.1:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then(async () => {
                            // Test invalid username and bad password
                            const opts = getRequestOpts('/whatever');
                            opts.proxyUrl = `${proxySchema}://bad-username:bad-password@127.0.0.1:${mainProxyServerPort}`;
                            return testForErrorResponse(opts, 407);
                        })
                        .then((response) => {
                            // Check we received our authRealm
                            if (!useSsl) {
                                if (response === undefined) throw new Error('Expected a response over plain HTTP.');
                                expect(response.headers['proxy-authenticate']).toBe(`Basic realm="${AUTH_REALM}"`);
                            }
                        });
                });

                it('returns 500 on error in prepareRequestFunction', async () => {
                    return Promise.resolve()
                        .then(async () => {
                            const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-throw.gov`);
                            return testForErrorResponse(opts, 500);
                        })
                        .then(async () => {
                            const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-promise.gov`);
                            return testForErrorResponse(opts, 500);
                        })
                        .then(async () => {
                            const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-throw-known.gov`);
                            return testForErrorResponse(opts, 501);
                        })
                        .then(async () => {
                            const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-error-in-prep-req-func-promise-known.gov`);
                            return testForErrorResponse(opts, 501);
                        });
                });
            }

            if (useUpstreamProxy) {
                it('fails gracefully on invalid upstream proxy scheme', async () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-scheme.gov`);
                    return testForErrorResponse(opts, 500);
                });

                it('fails gracefully on invalid upstream proxy URL', async () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-url.gov`);
                    return testForErrorResponse(opts, 500);
                });

                it('fails gracefully on invalid upstream proxy username', async () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-invalid-upstream-proxy-username`);

                    if (useSsl) {
                        await expectProxyTunnelError(httpRequest(opts), 597);
                    } else {
                        const response = await httpRequest(opts);

                        expect(response.statusCode).toBe(597);
                        expect(response.body).toBe('Invalid colon in username in upstream proxy credentials');
                    }
                });

                it('fails gracefully on non-existent upstream proxy host', async () => {
                    const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-unknown-upstream-proxy-host.gov`);
                    return testForErrorResponse(opts, 593);
                });

                if (upstreamProxyAuth) {
                    _it('fails gracefully on bad upstream proxy credentials', async () => {
                        const opts = getRequestOpts(`${useSsl ? 'https' : 'http'}://activate-bad-upstream-proxy-credentials.gov`);
                        return testForErrorResponse(opts, 597);
                    });
                }
            }

            if (testCustomResponse) {
                if (!useSsl) {
                    it('supports custom response - buffer', async () => {
                        const opts = getRequestOpts('http://test-custom-response-buffer.gov');
                        opts.headers['accept-encoding'] = 'gzip';
                        return httpRequest(opts)
                            .then((response) => {
                                expect(response.statusCode).toBe(200);
                                expect(response.body).toBe('Hello, world!');
                            });
                    });

                    it('supports custom response - simple', async () => {
                        const opts = getRequestOpts('http://test-custom-response-simple.gov/some/path');
                        return httpRequest(opts)
                            .then((response) => {
                                expect(response.statusCode).toBe(200);
                                expect(response.body).toBe('TEST CUSTOM RESPONSE SIMPLE');
                            });
                    });

                    it('supports custom response - complex', async () => {
                        const opts = getRequestOpts('http://test-custom-response-complex.gov:1234/some/path?query=456');
                        return httpRequest(opts)
                            .then((response) => {
                                expect(response.statusCode).toBe(201);
                                expect(response.headers).toMatchObject({
                                    'my-test-header1': 'bla bla bla',
                                    'my-test-header2': 'bla bla bla2',
                                });
                                expect(response.body).toBe('TEST CUSTOM RESPONSE COMPLEX');
                            });
                    });

                    it('supports custom response - long', async () => {
                        const opts = getRequestOpts('http://test-custom-response-long.gov');
                        return httpRequest(opts)
                            .then((response) => {
                                expect(response.statusCode).toBe(200);
                                expect(response.headers['content-length']).toBe('5000000');
                                expect(response.body).toHaveLength(5000000);
                                expect(response.body).toBe('X'.repeat(5000000));
                            });
                    });

                    it('supports custom response - promised', async () => {
                        const opts = getRequestOpts('http://test-custom-response-promised.gov/some/path');
                        return httpRequest(opts)
                            .then((response) => {
                                expect(response.statusCode).toBe(200);
                                expect(response.body).toBe('TEST CUSTOM RESPONSE PROMISED');
                            });
                    });

                    it('fails on invalid custom response function', async () => {
                        const opts = getRequestOpts('http://test-custom-response-invalid.gov');
                        return testForErrorResponse(opts, 500);
                    });
                } else {
                    it('does not support custom response in SSL mode', async () => {
                        const opts = getRequestOpts('https://test-custom-response-simple.gov/some/path');
                        return testForErrorResponse(opts, 500);
                    });
                }
            }
        }

        afterAll(async () => {
            // Teardown is asynchronous, so poll instead of sleeping a flat second —
            // this hook runs once per suite variant.
            await vi.waitFor(() => {
                if (mainProxyServer) {
                    expect(mainProxyServer.getConnectionIds()).toStrictEqual([]);
                }
                expect(mainProxyServerConnectionIds).toStrictEqual([]);
            });

            const closedSomeConnectionsTwice = mainProxyServerConnectionsClosed
                .reduce<number[]>((duplicateConnections, id, index) => {
                    if (index > 0 && mainProxyServerConnectionsClosed[index - 1] === id) {
                        duplicateConnections.push(id);
                    }
                    return duplicateConnections;
                }, []);

            expect(closedSomeConnectionsTwice).toStrictEqual([]);
            if (mainProxyServerStatisticsInterval) clearInterval(mainProxyServerStatisticsInterval);

            if (mainProxyServer) {
                // NOTE: we need to forcibly close pending connections,
                // because e.g. on 502 errors in HTTPS mode the client keeps
                // the connection open and this would time out.
                await mainProxyServer.close(true);
            }

            if (upstreamProxyServer) {
                // NOTE: We used to wait for upstream proxy connections to close,
                // but for HTTPS, in Node 10+, they linger for some reason...
                upstreamProxyServer.close();
            }

            if (targetServer) {
                await targetServer.close();
            }
        }, 3_000);
    };
};

// The suite launches Chromium and a proxy chain, so it owns its timeout rather than
// leaving every call site to remember it.
const describeTestSuite = (name: string, config: TestSuiteConfig) => describe(name, { timeout: TEST_SUITE_TIMEOUT_MILLIS }, createTestSuite(config));

describe('Test 0 port option', () => {
    it('Port inherits net port', async () => {
        for (let i = 0; i < 10; i++) {
            const server = new Server({
                port: 0,
            });

            await server.listen();
            expect(server.port).toBe(getServerPort(server.server));
            await server.close(true);
        }
    });
});

describe(`Test ${LOCALHOST_TEST} setup`, () => {
    it('works', async () => {
        return util.promisify(dns.lookup).bind(dns)(LOCALHOST_TEST, { family: 4 })
            .then(({ address, family }) => {
                // If this fails, see README.md !!!
                expect(address).toBe('127.0.0.1');
                expect(family).toBe(4);
            });
    });
});

// Test direct connection to target server to ensure our tests are correct
describeTestSuite('Server (HTTP -> Target)', {
    useSsl: false,
    useMainProxy: false,
});
describeTestSuite('Server (HTTPS -> Target)', {
    useSsl: true,
    useMainProxy: false,
});

describe('non-200 upstream connect response', () => {
    it('fails downstream with 590', async () => {
        // The assertions live in a 'connect' event handler, so plan them to be sure they ran.
        expect.assertions(3);

        const server = http.createServer();
        server.on('connect', (_request, socket) => {
            socket.once('error', () => {});
            socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 1\r\n\r\na');
        });
        await new Promise<void>((resolve) => server.listen(resolve));
        const serverPort = getServerPort(server);
        const proxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => {
                return {
                    upstreamProxyUrl: `http://localhost:${serverPort}`,
                };
            },
        });
        await proxyServer.listen();
        const proxyServerPort = proxyServer.port;

        await new Promise<void>((resolve) => {
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
                expect(response.statusCode).toBe(590);
                expect(response.statusMessage).toBe('UPSTREAM403');
                expect(head).toHaveLength(0);

                socket.once('close', async () => {
                    await proxyServer.close();
                    await new Promise((res) => server.close(res));
                    resolve();
                });
            });

            req.end();
        });
    });
});

it('supports localAddress', async () => {
    const target = http.createServer((serverRequest, serverResponse) => {
        serverResponse.end(serverRequest.socket.remoteAddress);
    });

    await listenOnPort(target);

    const server = new Server({
        port: 0,
        prepareRequestFunction: () => {
            return {
                localAddress: '127.0.0.2',
            };
        },
    });

    await server.listen();

    const response = await httpRequest({
        url: `http://127.0.0.1:${getServerPort(target)}`,
        proxyUrl: `http://127.0.0.2:${server.port}`,
    });

    try {
        expect(response.body).toBe('::ffff:127.0.0.2');
    } finally {
        await server.close();
        await util.promisify(target.close.bind(target))();
    }
});

it('supports https proxy relay', async () => {
    const target = https.createServer(() => {
    });
    target.listen(() => {
    });

    const proxyServer = new Server({
        port: 0,
        prepareRequestFunction: () => {
            console.log(`https://localhost:${getServerPort(target)}`);
            return {
                upstreamProxyUrl: `https://localhost:${getServerPort(target)}`,
            };
        },
    });
    let proxyServerError = false;
    proxyServer.on('requestFailed', () => {
        // requestFailed will be called if we pass an invalid proxy url
        proxyServerError = true;
    });

    await proxyServer.listen();

    try {
        await httpRequest({
            url: 'https://www.google.com',
            proxyUrl: `http://localhost:${proxyServer.port}`,
            ignoreCertificateErrors: true,
        });
    } catch {
        // the request fails with `Proxy response (599) !== 200 when HTTP Tunneling`
    }
    expect(proxyServerError).toBe(false);

    await proxyServer.close();
    await util.promisify(target.close.bind(target))();
});

it('supports custom CONNECT server handler', async () => {
    const server = new Server({
        port: 0,
        prepareRequestFunction: () => {
            const customConnectServer = http.createServer((_request, response) => {
                response.end('Hello, world!');
            });

            return {
                customConnectServer,
            };
        },
    });

    await server.listen();

    try {
        const response = await new Promise<string>((resolve, reject) => {
            http.request(`http://127.0.0.1:${server.port}`, {
                method: 'CONNECT',
                path: 'example.com:80',
                headers: {
                    host: 'example.com:80',
                },
            }).on('connect', (_connectResponse, socket) => {
                http.request('http://example.com', {
                    createConnection: () => socket,
                }, (res) => {
                    const buffer: Buffer[] = [];

                    res.on('data', (chunk) => {
                        buffer.push(chunk);
                    });

                    res.on('end', () => {
                        resolve(Buffer.concat(buffer).toString());
                    });
                }).on('error', reject).end();
            }).on('error', reject).end();
        });

        expect(response).toBe('Hello, world!');
    } finally {
        await server.close();
    }
});

it('supports pre-response CONNECT payload', async () => {
    const plain = net.createServer((socket) => {
        socket.pipe(socket);
    });

    await new Promise<void>((resolve, reject) => {
        plain.once('error', reject);
        plain.listen(0, resolve);
    });

    const server = new Server({ port: 0 });
    await server.listen();

    try {
        const socket = net.connect({
            host: '127.0.0.1',
            port: server.port,
        });

        socket.write([
            `CONNECT 127.0.0.1:${getServerPort(plain)} HTTP/1.1`,
            `Host: 127.0.0.1:${getServerPort(plain)}`,
            ``,
            `foobar`,
        ].join('\r\n'));

        const success = await new Promise<boolean>((resolve, reject) => {
            let received = false;

            socket.once('error', reject);
            socket.on('data', (data) => {
                received = data.includes('foobar');
                socket.end();
            });

            socket.setTimeout(1000, () => {
                socket.destroy(new Error('Socket timed out'));
            });

            socket.once('close', () => resolve(received));
        });

        if (!success) throw new Error('failure');
    } finally {
        await server.close();
        await closeServer(plain);
    }
});

describe('supports ignoreUpstreamProxyCertificate', () => {
    const serverOptions = {
        key: sslKey,
        cert: sslCrt,
    };

    const responseMessage = 'Hello World!';

    it('fails on upstream error', async () => {
        const target = https.createServer(serverOptions, (_req, res) => {
            res.write(responseMessage);
            res.end();
        });

        await listenOnPort(target);

        const proxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => {
                return {
                    upstreamProxyUrl: `https://localhost:${getServerPort(target)}`,
                };
            },
        });

        let proxyServerError = false;
        proxyServer.on('requestFailed', () => {
            // requestFailed will be called if we pass an invalid proxy url
            proxyServerError = true;
        });

        await proxyServer.listen();

        /**
         * request is sent with rejectUnauthorized: true
         * so when the SSL certificate is not trusted (self-signed, expired, invalid), client will reject the connection
         */
        const response = await httpRequest({
            proxyUrl: `http://localhost:${proxyServer.port}`,
            url: 'http://httpbin.org/ip',
        });

        expect(proxyServerError).toBe(false);

        expect(response.statusCode).toBe(599);

        await proxyServer.close();
        await util.promisify(target.close.bind(target))();
    });

    it('bypass upstream error', async () => {
        const target = https.createServer(serverOptions, (_req, res) => {
            res.write(responseMessage);
            res.end();
        });

        await listenOnPort(target);

        const proxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => {
                return {
                    ignoreUpstreamProxyCertificate: true,
                    upstreamProxyUrl: `https://localhost:${getServerPort(target)}`,
                };
            },
        });

        let proxyServerError = false;
        proxyServer.on('requestFailed', () => {
            // requestFailed will be called if we pass an invalid proxy url
            proxyServerError = true;
        });

        await proxyServer.listen();

        /**
         * request is sent with rejectUnauthorized: false
         * so when the SSL certificate is not trusted (self-signed, expired, invalid), client won't reject the connection
         */
        const response = await httpRequest({
            proxyUrl: `http://localhost:${proxyServer.port}`,
            url: 'http://httpbin.org/ip',
        });

        expect(proxyServerError).toBe(false);

        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(responseMessage);

        await proxyServer.close();
        await util.promisify(target.close.bind(target))();
    });
});

// Run all combinations of test parameters
const mainProxyServerTypeVariants: ('http' | 'https')[] = [
    'http',
    'https',
];

const useSslVariants = [
    false,
    true,
];
const mainProxyAuthVariants: (ProxyAuth | null)[] = [
    null,
    { username: 'user1', password: 'pass1' },
    { username: 'user2', password: '' },
    { username: '', password: 'pass3' },
];
const useUpstreamProxyVariants = [
    true,
    false,
];
const upstreamProxyAuthVariants: (UpstreamProxyAuth | null)[] = [
    null,
    { type: 'Basic', username: 'userA', password: '' },
    // Test special chars, note that we URI-encode just username when constructing the proxyUrl,
    // to test both correctly and incorrectly encoded auth
    { type: 'Basic', username: 'us%erB', password: 'p$as%sA' },
];

mainProxyServerTypeVariants.forEach((mainProxyServerType) => {
    useSslVariants.forEach((useSsl) => {
        mainProxyAuthVariants.forEach((mainProxyAuth) => {
            const proxyTypeLabel = mainProxyServerType === 'https' ? 'HTTPS' : 'HTTP';
            const baseDesc = `Server (${useSsl ? 'HTTPS' : 'HTTP'} -> ${proxyTypeLabel} Main proxy`;

            // Test custom response separately (it doesn't use upstream proxies)
            describeTestSuite(`${baseDesc} -> Target + custom responses)`, {
                useMainProxy: true,
                useSsl,
                mainProxyAuth,
                mainProxyServerType,
                testCustomResponse: true,
            });

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

                    describeTestSuite(desc, {
                        useMainProxy: true,
                        useSsl,
                        useUpstreamProxy,
                        mainProxyAuth,
                        mainProxyServerType,
                        upstreamProxyAuth,
                    });
                });
            });
        });
    });
});

describe('Socket error handler regression test', () => {
    let server: Server | undefined;
    let logs: string[] = [];
    const originalLog = console.log;

    beforeAll(() => {
        console.log = (...args: unknown[]) => {
            logs.push(args.join(' '));
            originalLog.apply(console, args);
        };
    });

    afterAll(() => {
        console.log = originalLog;
    });

    beforeEach(() => {
        logs = [];
    });

    afterEach(async () => {
        if (server) {
            await server.close(true);
            server = undefined;
        }
    });

    // The bug was checking `this.listenerCount('error')` (Server) instead of `socket.listenerCount('error')`.
    // By adding an error listener to the Server, we make server.listenerCount('error') === 1.
    // With buggy code: condition becomes TRUE (1 === 1) and incorrectly logs.
    // With fixed code: condition stays FALSE (socket has 2 listeners, 2 !== 1) and correctly doesn't log.
    it('does not log when server has 1 error listener but socket has multiple', async () => {
        server = new Server({ port: 0, verbose: true });

        server.on('error', () => {});

        const connected = new Promise<net.Socket>((resolve) => server!.server.once('connection', resolve));

        await server.listen();
        net.connect(server.port, '127.0.0.1');

        const serverSocket = await connected;
        await new Promise(setImmediate);

        expect(server.listenerCount('error')).toBe(1);
        expect(serverSocket.listenerCount('error')).toBe(2);

        serverSocket.emit('error', new Error('Regression test error'));
        await wait(50);

        const hasLog = logs.some((log) => log.includes('Source socket emitted error') && log.includes('Regression test error'));
        expect(hasLog, 'Should check socket.listenerCount, not this.listenerCount (server)').toBe(false);

        serverSocket.destroy();
    });
});

describe('Server constructor', () => {
    it('should default to "http" when serverType is not specified', async () => {
        const server = new Server({ port: 0 });
        await server.listen();
        expect(server.serverType).toBe('http');
        expect(server.server).toBeInstanceOf(http.Server);
        await server.close(true);
    });

    it('should use "http" when explicitly specified', async () => {
        const server = new Server({ port: 0, serverType: 'http' });
        await server.listen();
        expect(server.serverType).toBe('http');
        expect(server.server).toBeInstanceOf(http.Server);
        await server.close(true);
    });

    it('should use "https" when explicitly specified with httpsOptions', async () => {
        const server = new Server({
            port: 0,
            serverType: 'https',
            httpsOptions: { key: sslKey, cert: sslCrt },
        });
        await server.listen();
        expect(server.serverType).toBe('https');
        expect(server.server).toBeInstanceOf(https.Server);
        await server.close(true);
    });

    it('requires httpsOptions when serverType is "https"', () => {
        expect(() => {
            // @ts-expect-error - httpsOptions is deliberately omitted; the constructor must throw.
            // eslint-disable-next-line no-new -- constructed only to assert that it throws.
            new Server({
                port: 0,
                serverType: 'https',
            });
        }).toThrow('httpsOptions is required when serverType is "https"');
    });
});
