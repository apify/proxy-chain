import type { Buffer } from 'buffer';
import type { EventEmitter } from 'events';
import type http from 'http';
import type net from 'net';
import { URL } from 'url';

import { type SocksClientError, SocksClient, type SocksProxy } from 'socks';

import type { Socket } from './socket.js';
import { createCustomStatusHttpResponse, socksErrorMessageToStatusCode } from './statuses.js';
import { countTargetBytes } from './utils/count_target_bytes.js';

export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    customTag?: unknown;
}

interface ChainSocksOpts {
    request: http.IncomingMessage,
    sourceSocket: Socket;
    head: Buffer;
    server: EventEmitter & { log: (connectionId: unknown, str: string) => void };
    handlerOpts: HandlerOpts;
}

const socksProtocolToVersionNumber = (protocol: string): 4 | 5 => {
    switch (protocol) {
        case 'socks4:':
        case 'socks4a:':
            return 4;
        default:
            return 5;
    }
};

/**
 * Client -> Apify (CONNECT) -> Upstream (SOCKS) -> Web
 * Client <- Apify (CONNECT) <- Upstream (SOCKS) <- Web
 */
export const chainSocks = async ({
    request,
    sourceSocket,
    head,
    server,
    handlerOpts,
}: ChainSocksOpts): Promise<void> => {
    const { proxyChainId } = sourceSocket;

    const { hostname, port, username, password } = handlerOpts.upstreamProxyUrlParsed;

    const proxy: SocksProxy = {
        host: hostname,
        port: Number(port),
        type: socksProtocolToVersionNumber(handlerOpts.upstreamProxyUrlParsed.protocol),
        userId: decodeURIComponent(username),
        password: decodeURIComponent(password),
    };

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

    const url = new URL(`connect://${request.url}`);
    const destination = {
        port: Number(url.port),
        host: url.hostname,
    };

    let targetSocket: net.Socket;

    try {
        const client = await SocksClient.createConnection({
            proxy,
            command: 'connect',
            destination,
        });
        targetSocket = client.socket;

        sourceSocket.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
    } catch (error) {
        const socksError = error as SocksClientError;
        server.log(proxyChainId, `Failed to connect to upstream SOCKS proxy ${socksError.stack}`);
        sourceSocket.end(createCustomStatusHttpResponse(socksErrorMessageToStatusCode(socksError.message), socksError.message));
        return;
    }

    countTargetBytes(sourceSocket, targetSocket);

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

    targetSocket.on('error', (error) => {
        server.log(proxyChainId, `Chain SOCKS Destination Socket Error: ${error.stack}`);

        sourceSocket.destroy();
    });

    sourceSocket.on('error', (error) => {
        server.log(proxyChainId, `Chain SOCKS Source Socket Error: ${error.stack}`);

        targetSocket.destroy();
    });
};
