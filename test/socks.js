const portastic = require('portastic');
const socksv5 = require('socksv5');
const { gotScraping } = require('got-scraping');
const { expect } = require('chai');
const ProxyChain = require('../src/index');

describe('SOCKS protocol', () => {
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
            socksServer = socksv5.createServer((info, accept) => {
                accept();
            });
            socksServer.listen(socksPort, '0.0.0.0', () => {
                socksServer.useAuth(socksv5.auth.None());

                proxyServer = new ProxyChain.Server({
                    port: proxyPort,
                    prepareRequestFunction() {
                        return {
                            upstreamProxyUrl: `socks://127.0.0.1:${socksPort}`,
                        };
                    },
                });
                proxyServer.listen(() => {
                    gotScraping.get({ url: 'https://example.com', proxyUrl: `http://127.0.0.1:${proxyPort}` })
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
            socksServer = socksv5.createServer((info, accept) => {
                accept();
            });
            socksServer.listen(socksPort, '0.0.0.0', () => {
                socksServer.useAuth(socksv5.auth.UserPassword((user, password, cb) => {
                    cb(user === 'proxy-ch@in' && password === 'rules!');
                }));

                proxyServer = new ProxyChain.Server({
                    port: proxyPort,
                    prepareRequestFunction() {
                        return {
                            upstreamProxyUrl: `socks://proxy-ch@in:rules!@127.0.0.1:${socksPort}`,
                        };
                    },
                });
                proxyServer.listen(() => {
                    gotScraping.get({ url: 'https://example.com', proxyUrl: `http://127.0.0.1:${proxyPort}` })
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
            socksServer = socksv5.createServer((info, accept) => {
                accept();
            });
            socksServer.listen(socksPort, '0.0.0.0', () => {
                socksServer.useAuth(socksv5.auth.UserPassword((user, password, cb) => {
                    cb(user === 'proxy-ch@in' && password === 'rules!');
                }));

                ProxyChain.anonymizeProxy({ port: proxyPort, url: `socks://proxy-ch@in:rules!@127.0.0.1:${socksPort}` }).then((anonymizedProxyUrl) => {
                    anonymizeProxyUrl = anonymizedProxyUrl;
                    gotScraping.get({ url: 'https://example.com', proxyUrl: anonymizedProxyUrl })
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
