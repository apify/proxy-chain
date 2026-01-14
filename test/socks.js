import portastic from 'portastic';
import socksv5 from 'socksv5';
import { gotScraping } from 'got-scraping';
import { expect } from 'chai';
import * as ProxyChain from '../dist/index.js';

describe('SOCKS protocol', () => {
    let socksServer;
    let proxyServer;
    let anonymizeProxyUrl;

    afterEach(() => {
        if (socksServer) socksServer.close();
        if (proxyServer) proxyServer.close();
        if (anonymizeProxyUrl) ProxyChain.closeAnonymizedProxy(anonymizeProxyUrl, true);
    });

    it('works without auth', async () => {
        const ports = await portastic.find({ min: 50000, max: 50250 });
        const [socksPort, proxyPort] = ports;
        socksServer = socksv5.createServer((info, accept) => {
            accept();
        });
        await new Promise((resolve) => socksServer.listen(socksPort, '0.0.0.0', resolve));
        socksServer.useAuth(socksv5.auth.None());

        proxyServer = new ProxyChain.Server({
            port: proxyPort,
            prepareRequestFunction() {
                return {
                    upstreamProxyUrl: `socks://127.0.0.1:${socksPort}`,
                };
            },
        });
        await proxyServer.listen();
        const response = await gotScraping.get({ url: 'https://example.com', proxyUrl: `http://127.0.0.1:${proxyPort}` });
        expect(response.body).to.contain('Example Domain');
    }).timeout(10 * 1000);

    it('work with auth', async () => {
        const ports = await portastic.find({ min: 50250, max: 50500 });
        const [socksPort, proxyPort] = ports;
        socksServer = socksv5.createServer((info, accept) => {
            accept();
        });
        await new Promise((resolve) => socksServer.listen(socksPort, '0.0.0.0', resolve));
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
        await proxyServer.listen();
        const response = await gotScraping.get({ url: 'https://example.com', proxyUrl: `http://127.0.0.1:${proxyPort}` });
        expect(response.body).to.contain('Example Domain');
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
