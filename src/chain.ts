import type { Buffer } from 'node:buffer';
import type dns from 'node:dns';
import type { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { URL } from 'node:url';

import type { Socket } from './socket';
import { badGatewayStatusCodes, createCustomStatusHttpResponse, errorCodeToStatusCode } from './statuses';
import type { SocketWithPreviousStats } from './utils/count_target_bytes';
import { countTargetBytes } from './utils/count_target_bytes';
import { getBasicAuthorizationHeader } from './utils/get_basic';

interface Options {
    method: string;
    headers: Record<string, string>;
    path?: string;
    localAddress?: string;
    family?: number;
    lookup?: typeof dns['lookup'];
}

export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    ignoreUpstreamProxyCertificate: boolean;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
    customTag?: unknown;
    httpAgent?: http.Agent;
    httpsAgent?: https.Agent;
}

interface ChainOpts {
    request: { url?: string };
    sourceSocket: Socket;
    head?: Buffer;
    handlerOpts: HandlerOpts;
    server: EventEmitter & { log: (connectionId: unknown, str: string) => void };
    isPlain: boolean;
}

/**
 * Passes the traffic to upstream HTTP proxy server.
 * Client -> Apify -> Upstream -> Web
 * Client <- Apify <- Upstream <- Web
 */
export const chain = (
    {
        request,
        sourceSocket,
        head,
        handlerOpts,
        server,
        isPlain,
    }: ChainOpts,
): void => {
    if (head && head.length > 0) {
        // HTTP/1.1 has no defined semantics when sending payload along with CONNECT and servers can reject the request.
        // HTTP/2 only says that subsequent DATA frames must be transferred after HEADERS has been sent.
        // HTTP/3 says that all DATA frames should be transferred (implies pre-HEADERS data).
        //
        // Let's go with the HTTP/3 behavior.
        // There are also clients that send payload along with CONNECT to save milliseconds apparently.
        // Beware of upstream proxy servers that send out valid CONNECT responses with diagnostic data such as IPs!
        sourceSocket.unshift(head);
    }

    const { proxyChainId } = sourceSocket;

    const { upstreamProxyUrlParsed: proxy, customTag } = handlerOpts;

    const options: Options = {
        method: 'CONNECT',
        path: request.url,
        headers: {
            host: request.url!,
        },
        localAddress: handlerOpts.localAddress,
        family: handlerOpts.ipFamily,
        lookup: handlerOpts.dnsLookup,
    };

    if (proxy.username || proxy.password) {
        options.headers['proxy-authorization'] = getBasicAuthorizationHeader(proxy);
    }

    const client = proxy.protocol === 'https:'
        ? https.request(proxy.origin, {
            ...options,
            rejectUnauthorized: !handlerOpts.ignoreUpstreamProxyCertificate,
            agent: handlerOpts.httpsAgent,
        })
        : http.request(proxy.origin, {
            ...options,
            agent: handlerOpts.httpAgent,
        });

    client.once('socket', (targetSocket: SocketWithPreviousStats) => {
        // Socket can be re-used by multiple requests.
        // That's why we need to track the previous stats.
        targetSocket.previousBytesRead = targetSocket.bytesRead;
        targetSocket.previousBytesWritten = targetSocket.bytesWritten;
        countTargetBytes(sourceSocket, targetSocket);
    });

    client.on('connect', (response, targetSocket, clientHead) => {
        if (sourceSocket.readyState !== 'open') {
            // Sanity check, should never reach.
            targetSocket.destroy();
            return;
        }

        targetSocket.on('error', (error) => {
            server.log(proxyChainId, `Chain Destination Socket Error: ${error.stack}`);

            sourceSocket.unpipe(targetSocket);
            targetSocket.unpipe(sourceSocket);
            sourceSocket.destroy();
        });

        sourceSocket.on('error', (error) => {
            server.log(proxyChainId, `Chain Source Socket Error: ${error.stack}`);

            sourceSocket.unpipe(targetSocket);
            targetSocket.unpipe(sourceSocket);
            targetSocket.destroy();
        });

        if (response.statusCode !== 200) {
            server.log(proxyChainId, `Failed to authenticate upstream proxy: ${response.statusCode}`);

            if (isPlain) {
                sourceSocket.end();
            } else {
                const { statusCode } = response;
                const status = statusCode === 401 || statusCode === 407
                    ? badGatewayStatusCodes.AUTH_FAILED
                    : badGatewayStatusCodes.NON_200;

                sourceSocket.end(createCustomStatusHttpResponse(status, `UPSTREAM${statusCode}`));
            }

            targetSocket.end();

            server.emit('tunnelConnectFailed', {
                proxyChainId,
                response,
                customTag,
                socket: targetSocket,
                head: clientHead,
            });

            return;
        }

        if (clientHead.length > 0) {
            // See comment above
            targetSocket.unshift(clientHead);
        }

        server.emit('tunnelConnectResponded', {
            proxyChainId,
            response,
            customTag,
            socket: targetSocket,
            head: clientHead,
        });

        try {
            sourceSocket.write(isPlain ? '' : `HTTP/1.1 200 Connection Established\r\n\r\n`);
        } catch (error) {
            targetSocket.destroy();
            sourceSocket.destroy(error as Error);
            return;
        }

        sourceSocket.pipe(targetSocket);
        targetSocket.pipe(sourceSocket);

        // Once target socket closes forcibly, the source socket gets paused.
        // We need to enable flowing, otherwise the socket would remain open indefinitely.
        // Nothing would consume the data, we just want to close the socket.
        targetSocket.on('close', () => {
            sourceSocket.unpipe(targetSocket);
            targetSocket.unpipe(sourceSocket);
            sourceSocket.resume();

            if (sourceSocket.writable) {
                sourceSocket.end();
            }
        });

        // Same here.
        sourceSocket.on('close', () => {
            sourceSocket.unpipe(targetSocket);
            targetSocket.unpipe(sourceSocket);
            targetSocket.resume();

            if (targetSocket.writable) {
                targetSocket.end();
            }
        });
    });

    client.on('error', (error: NodeJS.ErrnoException) => {
        server.log(proxyChainId, `Failed to connect to upstream proxy: ${error.stack}`);

        // The end socket may get connected after the client to proxy one gets disconnected.
        if (sourceSocket.readyState === 'open') {
            if (isPlain) {
                sourceSocket.end();
            } else {
                const statusCode = errorCodeToStatusCode[error.code!] ?? badGatewayStatusCodes.GENERIC_ERROR;
                const response = createCustomStatusHttpResponse(statusCode, error.code ?? 'Upstream Closed Early');
                sourceSocket.end(response);
            }
        }
    });

    sourceSocket.on('error', () => {
        client.destroy();
    });

    // In case the client ends the socket too early
    sourceSocket.on('close', () => {
        client.destroy();
    });

    client.end();
};
