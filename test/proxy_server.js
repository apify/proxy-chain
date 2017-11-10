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


const createTestSuite = ({ useSsl, useProxyChain, proxyChainAuth }) => {
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

        const proto = useSsl ? 'https' : 'http';

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
                            // console.log('Parsed "Proxy-Authorization": parsed: %j expected: %j : %s', parsed, proxyAuth, isEqual);
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
                mainProxyServerPort = freePorts[2];

                const opts = {
                    port: mainProxyServerPort,
                    verbose: true,
                    targetProxyUrl: 'http://username:password@localhost:8001'
                };

                mainProxyServer = new ProxyServer(opts);

                return mainProxyServer.listen();
            });
        });

        it('handles simple GET to target server directly', () => {
            const options = {
                url: `${proto}://localhost:${targetServerPort}/hello-world`,
                key: sslKey,
            };
            return requestPromised(options)
                .then((response) => {
                    expect(response.body).to.eql('Hello world!');
                    expect(response.statusCode).to.eql(200);
                });
        });

        it('handles simple GET', () => {
            after(() => { proxyChainWasCalled = false; });
            const options = {
                url: `${proto}://localhost:${targetServerPort}/hello-world`,
                key: sslKey,
                proxy: `http://localhost:${mainProxyServerPort}`,
            };
            return requestPromised(options)
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


describe('ProxyServer - HTTP / Direct', createTestSuite({
    useSsl: false,
    useProxyChain: false,
}));

describe('ProxyServer - HTTP / Proxy chain', createTestSuite({
    useSsl: false,
    useProxyChain: true,
    proxyChainAuth: { scheme: 'Basic', username: 'username', password: 'password' },
}));

describe('ProxyServer - HTTPS / Direct', createTestSuite({
    useSsl: true,
    useProxyChain: false
}));

describe('ProxyServer - HTTPS / Proxy chain', createTestSuite({
    useSsl: true,
    useProxyChain: true,
    proxyChainAuth: { scheme: 'Basic', username: 'username', password: 'password' },
}));
