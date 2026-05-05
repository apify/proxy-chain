import net from 'node:net';
import { URL } from 'node:url';

import { chain } from './chain.js';

const runningServers: Record<string, { server: net.Server, connections: Set<net.Socket> }> = {};

const getAddress = (server: net.Server) => {
    const { address: host, port, family } = server.address() as net.AddressInfo;

    if (family === 'IPv6') {
        return `[${host}]:${port}`;
    }

    return `${host}:${port}`;
};

export async function createTunnel(
    proxyUrl: string,
    targetHost: string,
    options?: {
        verbose?: boolean;
        ignoreProxyCertificate?: boolean;
    },
): Promise<string> {
    const parsedProxyUrl = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(parsedProxyUrl.protocol)) {
        throw new Error(`The proxy URL must have the "http" or "https" protocol (was "${proxyUrl}")`);
    }

    const url = new URL(`connect://${targetHost || ''}`);

    if (!url.hostname) {
        throw new Error('Missing target hostname');
    }

    if (!url.port) {
        throw new Error('Missing target port');
    }

    const verbose = options && options.verbose;

    const server: net.Server & { log?: (...args: unknown[]) => void } = net.createServer();

    const log = (...args: unknown[]): void => {
        // eslint-disable-next-line no-console
        if (verbose) console.log(...args);
    };

    server.log = log;

    server.on('connection', (sourceSocket) => {
        const remoteAddress = `${sourceSocket.remoteAddress}:${sourceSocket.remotePort}`;

        const { connections } = runningServers[getAddress(server)];

        log(`new client connection from ${remoteAddress}`);

        sourceSocket.on('close', (hadError) => {
            connections.delete(sourceSocket);

            log(`connection from ${remoteAddress} closed, hadError=${hadError}`);
        });

        connections.add(sourceSocket);

        chain({
            request: { url: targetHost },
            sourceSocket,
            handlerOpts: {
                upstreamProxyUrlParsed: parsedProxyUrl,
                ignoreUpstreamProxyCertificate: options?.ignoreProxyCertificate ?? false,
            },
            server: server as net.Server & { log: typeof log },
            isPlain: true,
        });
    });

    const promise = new Promise<string>((resolve, reject) => {
        server.once('error', reject);

        // Let the system pick a random listening port
        server.listen(0, () => {
            const address = getAddress(server);

            server.off('error', reject);
            runningServers[address] = { server, connections: new Set() };

            log('server listening to ', address);

            resolve(address);
        });
    });

    return promise;
}

export async function closeTunnel(
    serverPath: string,
    closeConnections?: boolean,
): Promise<boolean> {
    const { hostname, port } = new URL(`tcp://${serverPath}`);
    if (!hostname) throw new Error('serverPath must contain hostname');
    if (!port) throw new Error('serverPath must contain port');

    const entry = runningServers[serverPath];
    if (!entry) return false;

    if (closeConnections) {
        for (const connection of entry.connections) {
            connection.destroy();
        }
    }

    await new Promise<void>((resolve) => {
        entry.server.close(() => {
            delete runningServers[serverPath];
            resolve();
        });
    });

    return true;
}
