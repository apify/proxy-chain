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

import { parseUrl } from '../build/tools';
import { ProxyServer } from '../build/proxy_server';
import { TargetServer } from './target_server';

/* globals process */


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
                            const parsed = basicAuthParser(auth);
                            const isEqual = _.isEqual(parsed, proxyChainAuth);
                            console.log('Parsed "Proxy-Authorization": parsed: %j expected: %j : %s', parsed, proxyAuth, isEqual);
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
                        verbose: true,
                    };

                    if (useProxyChain) {
                        opts.proxyChainUrlFunction = ({ request, username, hostname, port, protocol }) => {
                            return Promise.resolve(`http://${proxyChainAuth ? proxyChainAuth + '@' : ''}localhost:${proxyChainPort}`);
                        };
                    }

                    mainProxyServer = new ProxyServer(opts);

                    return mainProxyServer.listen();
                }
            }).then(() => {
                // Generate URLs
                baseUrl = `${useSsl ? 'https' : 'http'}://localhost:${targetServerPort}`;
                if (useMainProxy) mainProxyUrl = `http://${mainProxyAuth ? mainProxyAuth + '@' : ''}localhost:${mainProxyServerPort}`;
            });
        });

        it('handles GET /hello-world', () => {
            after(() => { proxyChainWasCalled = false; });
            const opts = getRequestOpts('/hello-world');
            console.log('REQUEST OPTIONS');
            console.dir(_.omit(opts, 'key'));
            return requestPromised(opts)
                .then((response) => {
                    expect(response.body).to.eql('Hello world!');
                    expect(response.statusCode).to.eql(200);

                    if (useProxyChain) {
                        expect(proxyChainWasCalled).to.eql(true);
                    }
                });
        });

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
describe('HTTP -> Target', createTestSuite({
    useSsl: false,
    useMainProxy: false,
    useProxyChain: false,
}));

describe('HTTP -> Proxy -> Target', createTestSuite({
    useSsl: false,
    useMainProxy: true,
    useProxyChain: false,
}));

/*

describe('HTTP -> Proxy -> Proxy (with auth) -> Target', createTestSuite({
    useSsl: false,
    useMainProxy: true,
    useProxyChain: true,
    proxyChainAuth: { scheme: 'Basic', username: 'username', password: 'password' },
}));

describe('HTTPS -> Target', createTestSuite({
    useSsl: true,
    useMainProxy: false,
    useProxyChain: false,
}));

describe('HTTPS -> Proxy -> Proxy -> Target', createTestSuite({
    useSsl: true,
    useMainProxy: true,
    useProxyChain: false
}));

describe('HTTPS -> Proxy -> Proxy (with auth) -> Target', createTestSuite({
    useSsl: true,
    useMainProxy: true,
    useProxyChain: true,
    proxyChainAuth: { scheme: 'Basic', username: 'username', password: 'password' },
}));

*/