import net from 'net';
import http from 'http';
import { Buffer } from 'buffer';
import { URL } from 'url';
import { Server } from './server';
import { nodeify } from './utils/nodeify';

// Dictionary, key is value returned from anonymizeProxy(), value is Server instance.
const anonymizedProxyUrlToServer: Record<string, Server> = {};

export interface AnonymizeProxyOptions {
    url: string;
    port: number;
}

/**
 * Parses and validates a HTTP proxy URL. If the proxy requires authentication, then the function
 * starts an open local proxy server that forwards to the upstream proxy.
 */
export const anonymizeProxy = (
    options: string | AnonymizeProxyOptions,
    callback?: (error: Error | null) => void,
): Promise<string> => {
    let proxyUrl: string;
    let port = 0;

    if (typeof options === 'string') {
        proxyUrl = options;
    } else {
        proxyUrl = options.url;
        port = options.port;

        if (port < 0 || port > 65535) {
            throw new Error(
                'Invalid "port" option: only values equals or between 0-65535 are valid',
            );
        }
    }

    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol !== 'http:') {
        throw new Error(
            'Invalid "proxyUrl" option: only HTTP proxies are currently supported.',
        );
    }

    // If upstream proxy requires no password, return it directly
    if (!parsedProxyUrl.username && !parsedProxyUrl.password) {
        return nodeify(Promise.resolve(proxyUrl), callback);
    }

    let server: Server & { port: number };

    const startServer = () => {
        return Promise.resolve().then(() => {
            server = new Server({
                // verbose: true,
                port,
                prepareRequestFunction: () => {
                    return {
                        requestAuthentication: false,
                        upstreamProxyUrl: proxyUrl,
                    };
                },
            }) as Server & { port: number };

            return server.listen();
        });
    };

    const promise = startServer().then(() => {
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
 * @param closeConnections If true, pending proxy connections are forcibly closed.
 */
export const closeAnonymizedProxy = (
    anonymizedProxyUrl: string,
    closeConnections: boolean,
    callback?: (error: Error | null, result?: boolean) => void,
): Promise<boolean> => {
    if (typeof anonymizedProxyUrl !== 'string') {
        throw new Error('The "anonymizedProxyUrl" parameter must be a string');
    }

    const server = anonymizedProxyUrlToServer[anonymizedProxyUrl];
    if (!server) {
        return nodeify(Promise.resolve(false), callback);
    }

    delete anonymizedProxyUrlToServer[anonymizedProxyUrl];

    const promise = server.close(closeConnections).then(() => {
        return true;
    });
    return nodeify(promise, callback);
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
