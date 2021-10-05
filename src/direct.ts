import net from 'net';
import { Buffer } from 'buffer';
import { URL } from 'url';
import { EventEmitter } from 'events';
import { countTargetBytes } from './utils/count_target_bytes';

interface DirectOpts {
    request: { url?: string },
    sourceSocket: net.Socket,
    head: Buffer,
    server: EventEmitter & { log: (...args: any[]) => void; },
}

export const direct = (
    {
        request,
        sourceSocket,
        head,
        server,
    }: DirectOpts,
): void => {
    const url = new URL(`connect://${request.url}`);

    if (!url.hostname) {
        throw new Error('Missing CONNECT hostname');
    }

    if (!url.port) {
        throw new Error('Missing CONNECT port');
    }

    if (head.length > 0) {
        throw new Error(`Unexpected data on CONNECT: ${head.length} bytes`);
    }

    const options = {
        port: Number(url.port),
        host: url.hostname,
    };

    if (options.host[0] === '[') {
        options.host = options.host.slice(1, -1);
    }

    const targetSocket = net.createConnection(options, () => {
        try {
            sourceSocket.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
        } catch (error) {
            sourceSocket.destroy(error as Error);
        }
    });

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

    const { proxyChainId } = sourceSocket as unknown as { proxyChainId: unknown };

    targetSocket.on('error', (error) => {
        server.log(proxyChainId, `Direct Destination Socket Error: ${error.stack}`);

        sourceSocket.destroy();
    });

    sourceSocket.on('error', (error) => {
        server.log(proxyChainId, `Direct Source Socket Error: ${error.stack}`);

        targetSocket.destroy();
    });
};