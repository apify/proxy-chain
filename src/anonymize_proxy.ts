import type { Buffer } from 'node:buffer';
import type http from 'node:http';
import type net from 'node:net';
import { URL } from 'node:url';

import { Server, SOCKS_PROTOCOLS } from './server.js';
import { validateListenPort } from './utils/validate_listen_port.js';

// Dictionary, key is value returned from anonymizeProxy(), value is Server instance.
const anonymizedProxyUrlToServer: Record<string, Server> = {};

export interface AnonymizeProxyOptions {
    url: string;
    port?: number;
    ignoreProxyCertificate?: boolean;
}

/**
 * Parses and validates a HTTP proxy URL. If the proxy requires authentication,
 * or if it is an HTTPS proxy and `ignoreProxyCertificate` is `true`, then the function
 * starts an open local proxy server that forwards to the upstream proxy.
 */
export const anonymizeProxy = async (
    options: string | AnonymizeProxyOptions,
): Promise<string> => {
    let proxyUrl: string;
    let port = 0;
    let ignoreProxyCertificate = false;

    if (typeof options === 'string') {
        proxyUrl = options;
    } else {
        proxyUrl = options.url;
        // Port 0 tells the OS to pick a free ephemeral port, which we read back after `listen()`.
        port = options.port ?? 0;

        validateListenPort(port);

        if (options.ignoreProxyCertificate !== undefined) {
            ignoreProxyCertificate = options.ignoreProxyCertificate;
        }
    }

    const parsedProxyUrl = new URL(proxyUrl);
    if (!['http:', 'https:', ...SOCKS_PROTOCOLS].includes(parsedProxyUrl.protocol)) {
        throw new Error(`Invalid "proxyUrl" provided: URL must have one of the following protocols: "http", "https", ${SOCKS_PROTOCOLS.map((p) => `"${p.replace(':', '')}"`).join(', ')} (was "${parsedProxyUrl}")`);
    }

    // If upstream proxy requires no password or if there is no need to ignore HTTPS proxy cert errors, return it directly
    if (!parsedProxyUrl.username && !parsedProxyUrl.password && (!ignoreProxyCertificate || parsedProxyUrl.protocol !== 'https:')) {
        return proxyUrl;
    }

    const server = new Server({
        // verbose: true,
        port,
        host: '127.0.0.1',
        prepareRequestFunction: () => {
            return {
                requestAuthentication: false,
                upstreamProxyUrl: proxyUrl,
                ignoreUpstreamProxyCertificate: ignoreProxyCertificate,
            };
        },
    }) as Server & { port: number };

    await server.listen();

    const url = `http://127.0.0.1:${server.port}`;
    anonymizedProxyUrlToServer[url] = server;
    return url;
};

/**
 * Closes anonymous proxy previously started by `anonymizeProxy()`.
 * If proxy was not found or was already closed, the function has no effect
 * and its result if `false`. Otherwise the result is `true`.
 * @param closeConnections If true, pending proxy connections are forcibly closed.
 */
export const closeAnonymizedProxy = async (
    anonymizedProxyUrl: string,
    closeConnections: boolean,
): Promise<boolean> => {
    if (typeof anonymizedProxyUrl !== 'string') {
        throw new Error('The "anonymizedProxyUrl" parameter must be a string');
    }

    const server = anonymizedProxyUrlToServer[anonymizedProxyUrl];
    if (!server) {
        return false;
    }

    delete anonymizedProxyUrlToServer[anonymizedProxyUrl];

    await server.close(closeConnections);
    return true;
};

type Callback = ({
    response,
    socket,
    head,
}: {
    response: http.IncomingMessage;
    socket: net.Socket;
    head: Buffer;
}) => void;

/**
 * Add a callback on 'tunnelConnectResponded' Event in order to get headers from CONNECT tunnel to proxy
 * Useful for some proxies that are using headers to send information like ProxyMesh
 * @returns `true` if the callback is successfully configured, otherwise `false` (e.g. when an
 * invalid proxy URL is given).
 */
export const listenConnectAnonymizedProxy = (
    anonymizedProxyUrl: string,
    tunnelConnectRespondedCallback: Callback,
): boolean => {
    const server = anonymizedProxyUrlToServer[anonymizedProxyUrl];
    if (!server) {
        return false;
    }
    server.on('tunnelConnectResponded', ({ response, socket, head }) => {
        tunnelConnectRespondedCallback({ response, socket, head });
    });
    return true;
};
