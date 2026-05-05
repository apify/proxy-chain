import _ from 'underscore';
import { expect, assert } from 'chai';
import proxy from 'proxy';
import http from 'node:http';
import util from 'node:util';
import portastic from 'portastic';
import basicAuthParser from 'basic-auth-parser';
import request from 'request';
import express from 'express';

import { anonymizeProxy, closeAnonymizedProxy } from '../src/index.js';

let expressServer;
let proxyServer;
let proxyPort;
let testServerPort;
const proxyAuth = { scheme: 'Basic', username: 'username', password: '' };
let wasProxyCalled = false;

// Setup local proxy server and web server for the tests
before(async () => {
    const freePorts = await portastic.find({ min: 50000, max: 50100 });

    await new Promise((resolve, reject) => {
        const httpServer = http.createServer();

        // Setup proxy authorization
        httpServer.authenticate = function (req, fn) {
            // parse the "Proxy-Authorization" header
            const auth = req.headers['proxy-authorization'];
            if (!auth) {
                // optimization: don't invoke the child process if no
                // "Proxy-Authorization" header was given
                return fn(null, false);
            }
            const parsed = basicAuthParser(auth);
            const isEqual = _.isEqual(parsed, proxyAuth);
            if (isEqual) wasProxyCalled = true;
            fn(null, isEqual);
        };

        httpServer.on('error', reject);

        proxyServer = proxy(httpServer);
        proxyServer.listen(freePorts[0], () => {
            proxyPort = proxyServer.address().port;
            resolve();
        });
    });

    const app = express();
    app.get('/', (req, res) => res.send('Hello World!'));

    testServerPort = freePorts[1];
    await new Promise((resolve) => {
        expressServer = app.listen(testServerPort, resolve);
    });
});

after(async function () {
    this.timeout(5 * 1000);
    await new Promise((resolve) => expressServer.close(resolve));

    if (proxyServer) await util.promisify(proxyServer.close.bind(proxyServer))();
});

const requestPromised = (opts) => {
    // console.log('requestPromised');
    // console.dir(opts);
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) return reject(error);
            if (response.statusCode !== 200) {
                return reject(new Error(`Received invalid response code: ${response.statusCode}`));
            }
            if (opts.expectBodyContainsText) expect(body).to.contain(opts.expectBodyContainsText);
            resolve();
        });
    });
};


describe('utils.anonymizeProxyNoPassword', function () {
    // Need larger timeout for Travis CI
    this.timeout(5 * 1000);
    it('anonymizes authenticated with no password upstream proxy', async () => {
        const [proxyUrl1, proxyUrl2] = await Promise.all([
            anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
            anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
        ]);

        expect(proxyUrl1).to.not.contain(`${proxyPort}`);
        expect(proxyUrl2).to.not.contain(`${proxyPort}`);
        expect(proxyUrl1).to.not.equal(proxyUrl2);

        // Test call through proxy 1
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).to.equal(true);

        // Test call through proxy 2
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl2,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).to.equal(true);

        // Test again call through proxy 1
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).to.equal(true);

        const closed1 = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1).to.eql(true);

        // Test proxy is really closed
        try {
            await requestPromised({ uri: proxyUrl1 });
            assert.fail();
        } catch (err) {
            // Node.js 20+ may return 'socket hang up' instead of 'ECONNREFUSED'
            const validErrors = ['ECONNREFUSED', 'socket hang up'];
            expect(validErrors.some((e) => err.message.includes(e))).to.equal(true);
        }

        const closed2 = await closeAnonymizedProxy(proxyUrl2, true);
        expect(closed2).to.eql(true);

        // Test the second-time call to close
        const closed1Again = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1Again).to.eql(false);

        const closed2Again = await closeAnonymizedProxy(proxyUrl2, false);
        expect(closed2Again).to.eql(false);
    });
});
