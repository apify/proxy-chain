import { Server } from './server';
import {
    parseUrl, nodeify,
} from './tools';

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
        return nodeify(Promise.resolve(false), callback);
    }

    delete anonymizedProxyUrlToServer[anonymizedProxyUrl];

    const promise = server.close(closeConnections)
        .then(() => {
            return true;
        });
    return nodeify(promise, callback);
};

/**
 * Add a callback on 'onTrgRequestConnect' Event in order to get headers from CONNECT tunnel to proxy
 * Useful for some proxies that are using headers to send information like ProxyMesh
 * @param anonymizedProxyUrl
 * @param onTrgRequestConnectCallback
 */
export const listenConnectAnonymizedProxy = (anonymizedProxyUrl, onTrgRequestConnectCallback) => {
    const server = anonymizedProxyUrlToServer[anonymizedProxyUrl];
    if (!server) {
        onTrgRequestConnectCallback(false);
    }
    server.on('onTrgRequestConnect', ({ response, socket, head }) => {
        onTrgRequestConnectCallback(response,socket,head);
    });
};
