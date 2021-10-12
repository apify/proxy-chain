<<<<<<< HEAD
import net from 'node:net';
import { URL } from 'node:url';

=======
import { URL } from 'url';
import net from 'net';
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
import { chain } from './chain';
import { nodeify } from './utils/nodeify';

const runningServers: Record<string, { server: net.Server, connections: Set<net.Socket> }> = {};

const getAddress = (server: net.Server) => {
    const { address: host, port, family } = server.address() as net.AddressInfo;

    if (family === 'IPv6') {
        return `[${host}]:${port}`;
    }

    return `${host}:${port}`;
};

<<<<<<< HEAD
export async function createTunnel(
    proxyUrl: string,
    targetHost: string,
    options?: {
        verbose?: boolean;
        ignoreProxyCertificate?: boolean;
=======
export function createTunnel(
    proxyUrl: string,
    targetHost: string,
    options: {
        verbose?: boolean;
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
    },
    callback?: (error: Error | null, result?: string) => void,
): Promise<string> {
    const parsedProxyUrl = new URL(proxyUrl);
<<<<<<< HEAD
    if (!['http:', 'https:'].includes(parsedProxyUrl.protocol)) {
        throw new Error(`The proxy URL must have the "http" or "https" protocol (was "${proxyUrl}")`);
=======
    if (parsedProxyUrl.protocol !== 'http:') {
        throw new Error(`The proxy URL must have the "http" protocol (was "${proxyUrl}")`);
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
    }

    const url = new URL(`connect://${targetHost || ''}`);

    if (!url.hostname) {
        throw new Error('Missing target hostname');
    }

    if (!url.port) {
        throw new Error('Missing target port');
    }

    const verbose = options && options.verbose;

<<<<<<< HEAD
    const server: net.Server & { log?: (...args: unknown[]) => void } = net.createServer();
=======
    const server = net.createServer();
>>>>>>> f1bbe42 (release: 2.0.0 (#162))

    const log = (...args: unknown[]): void => {
        if (verbose) console.log(...args);
    };

<<<<<<< HEAD
    server.log = log;
=======
    (server as any).log = log;
>>>>>>> f1bbe42 (release: 2.0.0 (#162))

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
<<<<<<< HEAD
            handlerOpts: {
                upstreamProxyUrlParsed: parsedProxyUrl,
                ignoreUpstreamProxyCertificate: options?.ignoreProxyCertificate ?? false,
            },
=======
            handlerOpts: { upstreamProxyUrlParsed: parsedProxyUrl },
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
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

    return nodeify(promise, callback);
}

<<<<<<< HEAD
export async function closeTunnel(
=======
export function closeTunnel(
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
    serverPath: string,
    closeConnections: boolean | undefined,
    callback: (error: Error | null, result?: boolean) => void,
): Promise<boolean> {
    const { hostname, port } = new URL(`tcp://${serverPath}`);
    if (!hostname) throw new Error('serverPath must contain hostname');
    if (!port) throw new Error('serverPath must contain port');

    const promise = new Promise((resolve) => {
<<<<<<< HEAD
        if (!runningServers[serverPath]) {
            resolve(false);
            return;
        }
        if (!closeConnections) {
            resolve(true);
            return;
        }
=======
        if (!runningServers[serverPath]) return resolve(false);
        if (!closeConnections) return resolve(true);
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
        for (const connection of runningServers[serverPath].connections) {
            connection.destroy();
        }
        resolve(true);
    })
<<<<<<< HEAD
        .then(async (serverExists) => new Promise<boolean>((resolve) => {
            if (!serverExists) {
                resolve(false);
                return;
            }
=======
        .then((serverExists) => new Promise<boolean>((resolve) => {
            if (!serverExists) return resolve(false);
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
            runningServers[serverPath].server.close(() => {
                delete runningServers[serverPath];
                resolve(true);
            });
        }));

    return nodeify(promise, callback);
}
