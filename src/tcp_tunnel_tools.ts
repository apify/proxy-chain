import net from 'node:net';
import { URL } from 'node:url';

import { chain } from './chain.js';
import { validateListenPort } from './utils/validate_listen_port.js';

const runningServers: Record<string, { server: net.Server, connections: Set<net.Socket> }> = {};

// The tunnel does not authenticate its clients and forwards the proxyUrl credentials
// upstream, so it must not be reachable off the local machine by default.
const DEFAULT_LISTEN_HOSTNAME = '127.0.0.1';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

const isLoopbackHostname = (hostname: string) => {
    const normalized = hostname.toLowerCase();

    return LOOPBACK_HOSTNAMES.has(normalized) || normalized.startsWith('127.');
};

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
        port?: number;
        hostname?: string;
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

    const listenPort = options?.port ?? 0;
    const listenHostname = options?.hostname || DEFAULT_LISTEN_HOSTNAME;

    validateListenPort(listenPort);

    if (!isLoopbackHostname(listenHostname)) {
        process.emitWarning(
            `The tunnel is listening on "${listenHostname}", so it may be reachable from other machines.`
            + ' It does not authenticate its clients and forwards the proxyUrl credentials upstream.',
            'ProxyChainSecurityWarning',
        );
    }

    const verbose = options?.verbose ?? false;

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

        server.listen(listenPort, listenHostname, () => {
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
