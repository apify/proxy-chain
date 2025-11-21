const fs = require('fs');
const path = require('path');
const portastic = require('portastic');
const socksv5 = require('socksv5');
const { gotScraping } = require('got-scraping');
const { expect } = require('chai');
const ProxyChain = require('../src/index');

// Load SSL certificates for HTTPS proxy server testing
const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

// Test both HTTP and HTTPS proxy server types with SOCKS upstream
const serverTypes = ['http', 'https'];

describe('SOCKS protocol', () => {
    serverTypes.forEach((serverType) => {
        describe(`Server (${serverType.toUpperCase()}) with SOCKS upstream`, () => {
            let socksServer;
            let proxyServer;
            let anonymizeProxyUrl;

            afterEach(() => {
                if (socksServer) socksServer.close();
                if (proxyServer) proxyServer.close();
                if (anonymizeProxyUrl) ProxyChain.closeAnonymizedProxy(anonymizeProxyUrl, true);
            });

            it('works without auth', (done) => {
                portastic.find({ min: 50000, max: 50250 }).then((ports) => {
                    const [socksPort, proxyPort] = ports;
                    socksServer = socksv5.createServer((_, accept) => {
                        accept();
                    });
                    socksServer.listen(socksPort, '0.0.0.0', () => {
                        socksServer.useAuth(socksv5.auth.None());

                        const serverOpts = {
                            port: proxyPort,
                            prepareRequestFunction() {
                                return {
                                    upstreamProxyUrl: `socks://127.0.0.1:${socksPort}`,
                                };
                            },
                        };

                        // Configure HTTPS proxy server if requested
                        if (serverType === 'https') {
                            serverOpts.serverType = 'https';
                            serverOpts.httpsOptions = {
                                key: sslKey,
                                cert: sslCrt,
                            };
                        }

                        proxyServer = new ProxyChain.Server(serverOpts);
                        proxyServer.listen(() => {
                            const proxyScheme = serverType === 'https' ? 'https' : 'http';
                            const proxyUrl = `${proxyScheme}://127.0.0.1:${proxyPort}`;

                            const gotOpts = {
                                url: 'https://example.com',
                                proxyUrl,
                            };

                            // Accept self-signed certificates when connecting to HTTPS proxy
                            if (serverType === 'https') {
                                gotOpts.https = { rejectUnauthorized: false };
                            }

                            gotScraping.get(gotOpts)
                                .then((response) => {
                                    expect(response.body).to.contain('Example Domain');
                                    done();
                                })
                                .catch(done);
                        });
                    });
                });
            }).timeout(10 * 1000);

            it('work with auth', (done) => {
                portastic.find({ min: 50250, max: 50500 }).then((ports) => {
                    const [socksPort, proxyPort] = ports;
                    socksServer = socksv5.createServer((_, accept) => {
                        accept();
                    });
                    socksServer.listen(socksPort, '0.0.0.0', () => {
                        socksServer.useAuth(socksv5.auth.UserPassword((user, password, cb) => {
                            cb(user === 'proxy-ch@in' && password === 'rules!');
                        }));

                        const serverOpts = {
                            port: proxyPort,
                            prepareRequestFunction() {
                                return {
                                    upstreamProxyUrl: `socks://proxy-ch@in:rules!@127.0.0.1:${socksPort}`,
                                };
                            },
                        };

                        // Configure HTTPS proxy server if requested
                        if (serverType === 'https') {
                            serverOpts.serverType = 'https';
                            serverOpts.httpsOptions = {
                                key: sslKey,
                                cert: sslCrt,
                            };
                        }

                        proxyServer = new ProxyChain.Server(serverOpts);
                        proxyServer.listen(() => {
                            const proxyScheme = serverType === 'https' ? 'https' : 'http';
                            const proxyUrl = `${proxyScheme}://127.0.0.1:${proxyPort}`;

                            const gotOpts = {
                                url: 'https://example.com',
                                proxyUrl,
                            };

                            // Accept self-signed certificates when connecting to HTTPS proxy
                            if (serverType === 'https') {
                                gotOpts.https = { rejectUnauthorized: false };
                            }

                            gotScraping.get(gotOpts)
                                .then((response) => {
                                    expect(response.body).to.contain('Example Domain');
                                    done();
                                })
                                .catch(done);
                        });
                    });
                });
            }).timeout(10 * 1000);

            it('works with anonymizeProxy', (done) => {
                portastic.find({ min: 50500, max: 50750 }).then((ports) => {
                    const [socksPort, proxyPort] = ports;
                    socksServer = socksv5.createServer((_, accept) => {
                        accept();
                    });
                    socksServer.listen(socksPort, '0.0.0.0', () => {
                        socksServer.useAuth(socksv5.auth.UserPassword((user, password, cb) => {
                            cb(user === 'proxy-ch@in' && password === 'rules!');
                        }));

                        const anonymizeOpts = {
                            port: proxyPort,
                            url: `socks://proxy-ch@in:rules!@127.0.0.1:${socksPort}`,
                        };

                        // Configure HTTPS proxy server if requested
                        if (serverType === 'https') {
                            anonymizeOpts.serverType = 'https';
                            anonymizeOpts.httpsOptions = {
                                key: sslKey,
                                cert: sslCrt,
                            };
                        }

                        ProxyChain.anonymizeProxy(anonymizeOpts).then((anonymizedProxyUrl) => {
                            anonymizeProxyUrl = anonymizedProxyUrl;

                            const gotOpts = {
                                url: 'https://example.com',
                                proxyUrl: anonymizedProxyUrl,
                            };

                            // Accept self-signed certificates when connecting to HTTPS proxy
                            if (serverType === 'https') {
                                gotOpts.https = { rejectUnauthorized: false };
                            }

                            gotScraping.get(gotOpts)
                                .then((response) => {
                                    expect(response.body).to.contain('Example Domain');
                                    done();
                                })
                                .catch(done);
                        });
                    });
                });
            }).timeout(10 * 1000);
        });
    });
});
