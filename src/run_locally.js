/*!
 * This script runs the proxy locally on port specified by PORT environment variable
 * or 8080 if not provided. This is used to manually test the proxy on normal browsing.
 *
 * node ./build/run_locally.js
 *
 * Author: Jan Curn (jan@apify.com)
 * Copyright(c) 2017 Apify Technologies. All rights reserved.
 *
 */


import { Server } from './server';

const server = new Server({
    port: process.env.PORT || 8080,
});

server.on('requestFailed', (err) => {
    console.error(`Request failed: ${err.stack || err}`);
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
