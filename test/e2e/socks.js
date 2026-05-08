import portastic from 'portastic';
import socksv5 from 'socksv5';
import { gotScraping } from 'got-scraping';
import { expect } from 'chai';
import * as ProxyChain from '../../src/index.js';

describe('SOCKS protocol', () => {
    let socksServer;
    let proxyServer;
    let anonymizeProxyUrl;

    afterEach(async () => {
        if (socksServer) socksServer.close();
        if (proxyServer) await proxyServer.close();
        if (anonymizeProxyUrl) await ProxyChain.closeAnonymizedProxy(anonymizeProxyUrl, true);
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

    it('works with anonymizeProxy', async () => {
        const ports = await portastic.find({ min: 50500, max: 50750 });
        const [socksPort, proxyPort] = ports;
        socksServer = socksv5.createServer((info, accept) => {
            accept();
        });
        await new Promise((resolve) => socksServer.listen(socksPort, '0.0.0.0', resolve));
        socksServer.useAuth(socksv5.auth.UserPassword((user, password, cb) => {
            cb(user === 'proxy-ch@in' && password === 'rules!');
        }));

        anonymizeProxyUrl = await ProxyChain.anonymizeProxy({
            port: proxyPort,
            url: `socks://proxy-ch@in:rules!@127.0.0.1:${socksPort}`,
        });
        const response = await gotScraping.get({ url: 'https://example.com', proxyUrl: anonymizeProxyUrl });
        expect(response.body).to.contain('Example Domain');
    }).timeout(10 * 1000);
});
