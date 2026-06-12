import { Buffer } from 'node:buffer';
import type dns from 'node:dns';
import type { EventEmitter } from 'node:events';
import type http from 'node:http';
import type https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { URL } from 'node:url';

import type { Socket } from './socket.js';
import { badGatewayStatusCodes, createCustomStatusHttpResponse, errorCodeToStatusCode } from './statuses.js';
import type { SocketWithPreviousStats } from './utils/count_target_bytes.js';
import { countTargetBytes } from './utils/count_target_bytes.js';
import { getBasicAuthorizationHeader } from './utils/get_basic.js';

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
 *
 * Uses raw TCP/TLS sockets to establish the upstream CONNECT tunnel rather
 * than `http.request().on('connect', ...)`. The latter is implemented on top
 * of `fetch()` in Bun 1.3 and (a) rejects non-URL CONNECT paths like `:443`
 * with "fetch() URL is invalid", (b) silently swallows the 407/590-class
 * upstream responses tests rely on. Speaking CONNECT directly over a socket
 * sidesteps both quirks without changing the behaviour on Node.
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

    const isHttps = proxy.protocol === 'https:';
    const proxyHost = proxy.hostname;
    const proxyPort = Number(proxy.port) || (isHttps ? 443 : 80);

    let connectRequest = `CONNECT ${request.url} HTTP/1.1\r\nHost: ${request.url}\r\n`;
    if (proxy.username || proxy.password) {
        connectRequest += `Proxy-Authorization: ${getBasicAuthorizationHeader(proxy)}\r\n`;
    }
    connectRequest += '\r\n';

    const socketOptions: net.TcpNetConnectOpts = {
        host: proxyHost,
        port: proxyPort,
        localAddress: handlerOpts.localAddress,
        family: handlerOpts.ipFamily as 4 | 6 | undefined,
        lookup: handlerOpts.dnsLookup,
    };

    let targetSocket: net.Socket;

    const onPreConnectError = (error: NodeJS.ErrnoException): void => {
        server.log(proxyChainId, `Failed to connect to upstream proxy: ${error.stack}`);

        if (sourceSocket.readyState === 'open') {
            if (isPlain) {
                sourceSocket.end();
            } else {
                const statusCode = errorCodeToStatusCode[error.code!] ?? badGatewayStatusCodes.GENERIC_ERROR;
                const response = createCustomStatusHttpResponse(statusCode, error.code ?? 'Upstream Closed Early');
                sourceSocket.end(response);
            }
        }
    };

    const onProxyConnected = (): void => {
        targetSocket.write(connectRequest);

        let responseBuffer = Buffer.alloc(0);

        const onData = (chunk: Buffer): void => {
            responseBuffer = Buffer.concat([responseBuffer, chunk]);

            const headerEnd = responseBuffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;

            targetSocket.removeListener('data', onData);

            const headerStr = responseBuffer.subarray(0, headerEnd).toString();
            const remaining = responseBuffer.subarray(headerEnd + 4);

            const statusMatch = headerStr.match(/^HTTP\/\d+(?:\.\d+)? (\d+)(?: (.*))?/);
            const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            const statusMessage = statusMatch ? (statusMatch[2] || '') : '';

            const headers: Record<string, string> = {};
            const rawHeaders: string[] = [];
            for (const line of headerStr.split('\r\n').slice(1)) {
                if (!line) continue;
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    const name = line.slice(0, colonIdx).trim();
                    const value = line.slice(colonIdx + 1).trim();
                    headers[name.toLowerCase()] = value;
                    rawHeaders.push(name, value);
                }
            }

            const response = { statusCode, statusMessage, headers, rawHeaders } as unknown as http.IncomingMessage;

            if (sourceSocket.readyState !== 'open') {
                targetSocket.destroy();
                return;
            }

            targetSocket.removeListener('error', onPreConnectError);

            targetSocket.on('error', (error) => {
                server.log(proxyChainId, `Chain Destination Socket Error: ${error.stack}`);
                sourceSocket.destroy();
            });

            sourceSocket.on('error', (error) => {
                server.log(proxyChainId, `Chain Source Socket Error: ${error.stack}`);
                targetSocket.destroy();
            });

            if (statusCode !== 200) {
                server.log(proxyChainId, `Failed to authenticate upstream proxy: ${statusCode}`);

                if (isPlain) {
                    sourceSocket.end();
                } else {
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
                    head: remaining,
                });

                return;
            }

            if (remaining.length > 0) {
                // See comment above re: pre-response CONNECT payload
                targetSocket.unshift(remaining);
            }

            server.emit('tunnelConnectResponded', {
                proxyChainId,
                response,
                customTag,
                socket: targetSocket,
                head: remaining,
            });

            sourceSocket.write(isPlain ? '' : `HTTP/1.1 200 Connection Established\r\n\r\n`);

            sourceSocket.pipe(targetSocket);
            targetSocket.pipe(sourceSocket);

            // Once target socket closes forcibly, the source socket gets paused.
            // We need to enable flowing, otherwise the socket would remain open indefinitely.
            // Nothing would consume the data, we just want to close the socket.
            targetSocket.on('close', () => {
                sourceSocket.resume();

                if (sourceSocket.writable) {
                    sourceSocket.end();
                }
            });

            // Same here.
            sourceSocket.on('close', () => {
                targetSocket.resume();

                if (targetSocket.writable) {
                    targetSocket.end();
                }
            });
        };

        targetSocket.on('data', onData);
    };

    if (isHttps) {
        // We connect directly instead of going through `https.request` with an
        // agent, but users may have configured TLS settings (custom `ca`,
        // client certs, ...) on `httpsAgent`. Honor those by re-using the
        // agent's stored constructor options for this connection.
        const httpsAgentOptions = handlerOpts.httpsAgent?.options as tls.ConnectionOptions | undefined;

        targetSocket = tls.connect({
            ...httpsAgentOptions,
            ...socketOptions,
            rejectUnauthorized: !handlerOpts.ignoreUpstreamProxyCertificate,
        }, onProxyConnected);
    } else {
        targetSocket = net.createConnection(socketOptions, onProxyConnected);
    }

    (targetSocket as SocketWithPreviousStats).previousBytesRead = 0;
    (targetSocket as SocketWithPreviousStats).previousBytesWritten = 0;
    countTargetBytes(sourceSocket, targetSocket);

    targetSocket.on('error', onPreConnectError);

    sourceSocket.on('error', () => {
        targetSocket.destroy();
    });

    // In case the client ends the socket too early
    sourceSocket.on('close', () => {
        targetSocket.destroy();
    });
};
