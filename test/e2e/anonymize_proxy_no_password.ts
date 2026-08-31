import http from 'node:http';

import basicAuthParser from 'basic-auth-parser';
import express from 'express';
import portastic from 'portastic';
import { createProxy, type ProxyServer } from 'proxy';
import request from 'request';
import _ from 'underscore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { anonymizeProxy, closeAnonymizedProxy } from '../../src/index.js';
import { PORT_RANGES } from '../utils/port_ranges.js';
import { closeServer, getServerPort, type RequestUriOpts } from '../utils/test_helpers.js';

let expressServer: http.Server | undefined;
let proxyServer: http.Server | undefined;
let proxyPort: number;
let testServerPort: number;
const proxyAuth = { scheme: 'Basic', username: 'username', password: '' };
let wasProxyCalled = false;

// Setup local proxy server and web server for the tests
beforeAll(async () => {
    const freePorts = await portastic.find(PORT_RANGES.anonymizeProxyNoPassword);

    await new Promise<void>((resolve, reject) => {
        const httpServer: ProxyServer = http.createServer();

        // Setup proxy authorization
        httpServer.authenticate = function (req) {
            // parse the "Proxy-Authorization" header
            const auth = req.headers['proxy-authorization'];
            if (!auth) return false;

            const parsed = basicAuthParser(auth);
            const isEqual = _.isEqual(parsed, proxyAuth);
            if (isEqual) wasProxyCalled = true;
            return isEqual;
        };

        httpServer.on('error', reject);

        const server = createProxy(httpServer);
        proxyServer = server;
        server.listen(freePorts[0], () => {
            proxyPort = getServerPort(server);
            resolve();
        });
    });

    const app = express();
    app.get('/', (_req, res) => res.send('Hello World!'));

    testServerPort = freePorts[1];
    await new Promise<void>((resolve) => {
        expressServer = app.listen(testServerPort, resolve);
    });
});

afterAll(async () => {
    if (expressServer) await closeServer(expressServer);

    if (proxyServer) await closeServer(proxyServer);
}, 5_000);

const requestPromised = async (opts: RequestUriOpts): Promise<void> => {
    // console.log('requestPromised');
    // console.dir(opts);
    return await new Promise((resolve, reject) => {
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
