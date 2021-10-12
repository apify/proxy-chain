/*!
 * This script runs the proxy with a second upstream proxy locally on port specified by PORT environment variable
 * or 8080 if not provided. This is used to manually test the proxy on normal browsing.
 *
 * node ./build/run_locally.js
 *
 * Author: Jan Curn (jan@apify.com)
 * Copyright(c) 2017 Apify Technologies. All rights reserved.
 *
 */

const http = require('http');
const proxy = require('proxy'); // eslint-disable-line import/no-extraneous-dependencies
const { Server } = require('../../src/server');

// Set up upstream proxy with no auth
const upstreamProxyHttpServer = http.createServer();

upstreamProxyHttpServer.on('error', (err) => {
    console.error(err.stack || err);
});

const upstreamProxyServer = proxy(upstreamProxyHttpServer);
const upstreamProxyPort = process.env.UPSTREAM_PROXY_PORT || 8081;
upstreamProxyServer.listen(process.env.UPSTREAM_PROXY_PORT || 8081, (err) => {
    if (err) {
        console.error(err.stack || err);
        process.exit(1);
    }
});

// Setup proxy to forward to upstream
const server = new Server({
    port: process.env.PORT || 8080,
    // verbose: true,
    prepareRequestFunction: () => {
        return { requestAuthentication: false, upstreamProxyUrl: `http://127.0.0.1:${upstreamProxyPort}` };
    },
});

server.on('requestFailed', ({ error, request }) => {
    console.error(`Request failed (${request ? request.url : 'N/A'}): ${error.stack || error}`);
});

server.listen()
    .then(() => {
        console.log(`Proxy server is running at http://127.0.0.1:${server.port}`);

        setInterval(() => {
            console.log(`Stats: ${JSON.stringify(server.stats)}`);
        }, 30000);
    })
    .catch((err) => {
        console.error(err.stack || err);
        process.exit(1);
    });
