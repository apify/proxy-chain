
/* globals module */

import http from 'http';
import proxy from 'proxy';
import _ from 'underscore';
import ProxyServer from './proxy_server';
import basicAuthParser from 'basic-auth-parser';

let proxyServer;
const proxyAuth = { scheme: 'Basic', username: 'username', password: 'password' };

new Promise((resolve, reject) => {
    const httpServer = http.createServer();

    // Setup proxy authorization
    httpServer.authenticate = function (req, fn) {
        // parse the "Proxy-Authorization" header
        const auth = req.headers['proxy-authorization'];
        if (!auth) {
            // optimization: don't invoke the child process if no
            // "Proxy-Authorization" header was given
            // console.log('not Proxy-Authorization');
            return fn(null, false);
        }
        const parsed = basicAuthParser(auth);
        const isEqual = _.isEqual(parsed, proxyAuth);
        console.log('Parsed "Proxy-Authorization": parsed: %j expected: %j : %s', parsed, proxyAuth, isEqual);
        //if (isEqual) wasProxyCalled = true;
        fn(null, isEqual);
    };

    httpServer.on('error', reject);

    proxyServer = proxy(httpServer);
    proxyServer.listen(8001, () => {
        console.log('Target proxy listening on port 8001');
        //proxyPort = proxyServer.address().port;
        resolve();
    });
})
.then(() => {
    //const server = new ProxyServer({ port: 8000, verbose: true, targetProxyUrl: 'http://username:password@localhost:8001' });
    const server = new ProxyServer({ port: 8000, verbose: true });

    server.listen();
})
.catch((err) => {
    console.log(err);
});






