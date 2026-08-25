import _ from 'underscore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import proxy from 'proxy';
import http from 'node:http';
import util from 'node:util';
import portastic from 'portastic';
import basicAuthParser from 'basic-auth-parser';
import request from 'request';
import express from 'express';

import { anonymizeProxy, closeAnonymizedProxy } from '../../src/index.js';

let expressServer;
let proxyServer;
let proxyPort;
let testServerPort;
const proxyAuth = { scheme: 'Basic', username: 'username', password: '' };
let wasProxyCalled = false;

// Setup local proxy server and web server for the tests
beforeAll(async () => {
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

afterAll(async () => {
    await new Promise((resolve) => expressServer.close(resolve));

    if (proxyServer) await util.promisify(proxyServer.close.bind(proxyServer))();
}, 5_000);

const requestPromised = (opts) => {
    // console.log('requestPromised');
    // console.dir(opts);
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) return reject(error);
            if (response.statusCode !== 200) {
                return reject(new Error(`Received invalid response code: ${response.statusCode}`));
            }
            if (opts.expectBodyContainsText) expect(body).toContain(opts.expectBodyContainsText);
            resolve();
        });
    });
};

describe('utils.anonymizeProxyNoPassword', { timeout: 5_000 }, () => {
    it('anonymizes authenticated with no password upstream proxy', async () => {
        const [proxyUrl1, proxyUrl2] = await Promise.all([
            anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
            anonymizeProxy(`http://${proxyAuth.username}:${proxyAuth.password}@127.0.0.1:${proxyPort}`),
        ]);

        expect(proxyUrl1).not.toContain(`${proxyPort}`);
        expect(proxyUrl2).not.toContain(`${proxyPort}`);
        expect(proxyUrl1).not.toBe(proxyUrl2);

        // Test call through proxy 1
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        // Test call through proxy 2
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl2,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        // Test again call through proxy 1
        wasProxyCalled = false;
        await requestPromised({
            uri: `http://localhost:${testServerPort}`,
            proxy: proxyUrl1,
            expectBodyContainsText: 'Hello World!',
        });
        expect(wasProxyCalled).toBe(true);

        const closed1 = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1).toBe(true);

        // Test proxy is really closed. Node.js 20+ may report 'socket hang up'
        // instead of 'ECONNREFUSED'.
        await expect(requestPromised({ uri: proxyUrl1 })).rejects.toThrow(/ECONNREFUSED|socket hang up/);

        const closed2 = await closeAnonymizedProxy(proxyUrl2, true);
        expect(closed2).toBe(true);

        // Test the second-time call to close
        const closed1Again = await closeAnonymizedProxy(proxyUrl1, true);
        expect(closed1Again).toBe(false);

        const closed2Again = await closeAnonymizedProxy(proxyUrl2, false);
        expect(closed2Again).toBe(false);
    });
});
