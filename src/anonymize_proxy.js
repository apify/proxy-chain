import Promise from 'bluebird';
import portastic from 'portastic';
import { Server } from './server';
import { parseUrl } from './tools';

// Dictionary, key is value returned from anonymizeProxy(), value is Server instance.
const anonymizedProxyUrlToServer = {};

export const ANONYMIZED_PROXY_PORTS = {
    FROM: 55000,
    TO: 65000,
};


const _findFreePort = () => {
    // Let 'min' be a random value in the first half of the PORT_FROM-PORT_TO range,
    // to reduce a chance of collision if other ProxyChain is started at the same time.
    const half = Math.floor((ANONYMIZED_PROXY_PORTS.TO - ANONYMIZED_PROXY_PORTS.FROM) / 2);

    const opts = {
        min: ANONYMIZED_PROXY_PORTS.FROM + Math.floor(Math.random() * half),
        max: ANONYMIZED_PROXY_PORTS.TO,
        retrieve: 1,
    };

    return portastic.find(opts)
        .then((ports) => {
            if (ports.length < 1) throw new Error(`There are no more free ports in range from ${ANONYMIZED_PROXY_PORTS.FROM} to ${ANONYMIZED_PROXY_PORTS.TO}`); // eslint-disable-line max-len
            return ports[0];
        });
};


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

    return Promise.resolve()
        .then(() => {
            return _findFreePort();
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
 * @param callback Optional callback
 * @returns Returns a promise if no callback was supplied
 */
export const closeAnonymizedProxy = (anonymizedProxyUrl, closeConnections, callback) => {
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
