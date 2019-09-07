import Promise from 'bluebird';
import { Server } from './server';
import { parseUrl, findFreePort, PORT_SELECTION_CONFIG } from './tools';

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
export const anonymizeProxy = (proxyUrl, callback) => {
    const parsedProxyUrl = parseUrl(proxyUrl);
    if (!parsedProxyUrl.host || !parsedProxyUrl.port) {
        throw new Error('Invalid "proxyUrl" option: the URL must contain both hostname and port.');
    }
    if (parsedProxyUrl.scheme !== 'http') {
        throw new Error('Invalid "proxyUrl" option: only HTTP proxies are currently supported.');
    }

    // If upstream proxy requires no password, return it directly
    if (!parsedProxyUrl.username && !parsedProxyUrl.password) {
        return Promise.resolve(proxyUrl).nodeify(callback);
    }

    let port;
    let server;

    const startServer = (maxRecursion) => {
        return Promise.resolve()
            .then(() => {
                return findFreePort();
            })
            .then((result) => {
                port = result;
                server = new Server({
                    // verbose: true,
                    port,
                    prepareRequestFunction: () => {
                        return {
                            requestAuthentication: false,
                            upstreamProxyUrl: proxyUrl,
                        };
                    },
                });

                return server.listen();
            })
            .catch((err) => {
                // It might happen that the port was taken in the meantime,
                // in which case retry the search
                if (err.code === 'EADDRINUSE' && maxRecursion > 0) {
                    return startServer(maxRecursion - 1);
                }
                throw err;
            });
    };

    return startServer(PORT_SELECTION_CONFIG.RETRY_COUNT)
        .then(() => {
            const url = `http://127.0.0.1:${port}`;
            anonymizedProxyUrlToServer[url] = server;
            return url;
        })
        .nodeify(callback);
};

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
export const closeAnonymizedProxy = (anonymizedProxyUrl, closeConnections, callback) => {
    if (typeof anonymizedProxyUrl !== 'string') {
        throw new Error('The "anonymizedProxyUrl" parameter must be a string');
    }

    const server = anonymizedProxyUrlToServer[anonymizedProxyUrl];
    if (!server) {
        return Promise
            .resolve(false)
            .nodeify(callback);
    }

    delete anonymizedProxyUrlToServer[anonymizedProxyUrl];

    return server.close(closeConnections)
        .then(() => {
            return true;
        })
        .nodeify(callback);
};
