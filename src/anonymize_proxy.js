const { Server } = require('./server');
const { nodeify } = require('./utils/nodeify');

// Dictionary, key is value returned from anonymizeProxy(), value is Server instance.
const anonymizedProxyUrlToServer = {};

/**
 * Parses and validates a HTTP proxy URL. If the proxy requires authentication, then the function
 * starts an open local proxy server that forwards to the upstream proxy.
 * @param proxyUrl
 * @param callback Optional callback that receives the anonymous proxy URL
 * @return If no callback was supplied, returns a promise that resolves to a String with
 * anonymous proxy URL or the original URL if it was already anonymous.
 */
const anonymizeProxy = (proxyUrl, callback) => {
    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol !== 'http:') {
        throw new Error('Invalid "proxyUrl" option: only HTTP proxies are currently supported.');
    }

    // If upstream proxy requires no password, return it directly
    if (!parsedProxyUrl.username && !parsedProxyUrl.password) {
        return nodeify(Promise.resolve(proxyUrl), callback);
    }

    let server;

    const startServer = () => {
        return Promise.resolve()
            .then(() => {
                server = new Server({
                    // verbose: true,
                    port: 0,
                    prepareRequestFunction: () => {
                        return {
                            requestAuthentication: false,
                            upstreamProxyUrl: proxyUrl,
                        };
                    },
                });

                return server.listen();
            });
    };

    const promise = startServer()
        .then(() => {
            const url = `http://127.0.0.1:${server.port}`;
            anonymizedProxyUrlToServer[url] = server;
            return url;
        });

    return nodeify(promise, callback);
};

module.exports.anonymizeProxy = anonymizeProxy;

/**
 * Closes anonymous proxy previously started by `anonymizeProxy()`.
 * If proxy was not found or was already closed, the function has no effect
 * and its result if `false`. Otherwise the result is `true`.
 * @param anonymizedProxyUrl
 * @param closeConnections If true, pending proxy connections are forcibly closed.
 * If `false`, the function will wait until all connections are closed, which can take a long time.
 * @param callback Optional callback
 * @returns Returns a promise if no callback was supplied
 */
const closeAnonymizedProxy = (anonymizedProxyUrl, closeConnections, callback) => {
    if (typeof anonymizedProxyUrl !== 'string') {
        throw new Error('The "anonymizedProxyUrl" parameter must be a string');
    }

    const server = anonymizedProxyUrlToServer[anonymizedProxyUrl];
    if (!server) {
        return nodeify(Promise.resolve(false), callback);
    }

    delete anonymizedProxyUrlToServer[anonymizedProxyUrl];

    const promise = server.close(closeConnections)
        .then(() => {
            return true;
        });
    return nodeify(promise, callback);
};

module.exports.closeAnonymizedProxy = closeAnonymizedProxy;

/**
 * Add a callback on 'tunnelConnectResponded' Event in order to get headers from CONNECT tunnel to proxy
 * Useful for some proxies that are using headers to send information like ProxyMesh
 * @param anonymizedProxyUrl
 * @param tunnelConnectRespondedCallback Callback to be invoked upon receiving the response. It
 * shall take an object as its parameter, with three keys `response`, `socket`, and `head` as
 * described here: https://nodejs.org/api/http.html#http_event_connect
 * @returns `true` if the callback is successfully configured, otherwise `false` (e.g. when an
 * invalid proxy URL is given).
 */
const listenConnectAnonymizedProxy = (anonymizedProxyUrl, tunnelConnectRespondedCallback) => {
    const server = anonymizedProxyUrlToServer[anonymizedProxyUrl];
    if (!server) {
        return false;
    }
    server.on('tunnelConnectResponded', ({ response, socket, head }) => {
        tunnelConnectRespondedCallback({ response, socket, head });
    });
    return true;
};

module.exports.listenConnectAnonymizedProxy = listenConnectAnonymizedProxy;
