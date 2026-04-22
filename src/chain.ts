import { Buffer } from 'node:buffer';
import type dns from 'node:dns';
import type { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { URL } from 'node:url';

import type { Socket } from './socket';
import { badGatewayStatusCodes, createCustomStatusHttpResponse, errorCodeToStatusCode } from './statuses';
import type { SocketWithPreviousStats } from './utils/count_target_bytes';
import { countTargetBytes } from './utils/count_target_bytes';
import { getBasicAuthorizationHeader } from './utils/get_basic';

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
 * Uses raw TCP/TLS sockets to establish the upstream CONNECT tunnel.
 * This is compatible with both Node.js and Bun.js, avoiding the
 * `http.ClientRequest` `connect` event which is not universally supported.
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

    const proxyHost = proxy.hostname;
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const isHttps = proxy.protocol === 'https:';

    // Build the CONNECT request to send to the upstream proxy
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

    // Pre-connect error handler – reports connection-level failures back to the source.
    // Replaced by a tunnel-phase handler once the CONNECT handshake succeeds.
    const onPreConnectError = (error: NodeJS.ErrnoException) => {
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

    const onProxyConnected = () => {
        // Send the CONNECT request to the upstream proxy
        targetSocket.write(connectRequest);

        // Read and parse the upstream proxy's HTTP response
        let responseBuffer = Buffer.alloc(0);

        const onData = (chunk: Buffer) => {
            responseBuffer = Buffer.concat([responseBuffer, chunk]);

            // Wait until we have received the complete response headers
            const headerEnd = responseBuffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;

            targetSocket.removeListener('data', onData);

            const headerStr = responseBuffer.slice(0, headerEnd).toString();
            const remaining = responseBuffer.slice(headerEnd + 4);

            // Parse status line: "HTTP/1.x NNN Message"
            const statusMatch = headerStr.match(/^HTTP\/\d+(?:\.\d+)? (\d+)(?: (.*))?/);
            const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            const statusMessage = statusMatch ? (statusMatch[2] || '') : '';

            // Parse response headers into key/value pairs
            const headers: Record<string, string> = {};
            for (const line of headerStr.split('\r\n').slice(1)) {
                if (!line) continue;
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    headers[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
                }
            }

            // Build a minimal response-like object for event emissions
            const response = { statusCode, statusMessage, headers } as unknown as http.IncomingMessage;

            if (sourceSocket.readyState !== 'open') {
                // Sanity check – source socket closed while we were connecting
                targetSocket.destroy();
                return;
            }

            // Switch from the pre-connect error handler to the tunnel-phase error handler
            // so that errors during tunneling are reported correctly and we don't attempt
            // to send an HTTP error response after the tunnel is already established.
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
                // Push any remaining bytes from the CONNECT response back onto the socket
                // so they are treated as the start of the tunnelled data stream.
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
        targetSocket = tls.connect({
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
