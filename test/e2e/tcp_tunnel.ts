import http from 'node:http';
import net from 'node:net';

import portastic from 'portastic';
import proxy from 'proxy';
import { afterEach, describe, expect, it } from 'vitest';

import { closeTunnel, createTunnel } from '../../src/index.js';
import { PORT_RANGES } from '../utils/port_ranges.js';
import { getServerPort, listenOnPort } from '../utils/test_helpers.js';

const destroySocket = async (socket: net.Socket): Promise<void> => new Promise((resolve) => {
    if (socket.destroyed) return resolve();
    socket.once('close', () => resolve());
    socket.destroy();
});

const connect = async (host: string, port: number): Promise<net.Socket> => new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
});

const closeServerAndConnections = async (server: net.Server, connections: net.Socket[]): Promise<void> => {
    if (!server.listening) return;
    await Promise.all(connections.map(destroySocket));
    await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
};

describe('tcp_tunnel.createTunnel', () => {
    it('throws error if proxyUrl is not in correct format', async () => {
        await expect(createTunnel('socks://user:password@whatever.com:123', 'localhost:9000')).rejects.toThrow(/must have the "http" or "https" protocol/);
        await expect(createTunnel('socks5://user:password@whatever.com', 'localhost:9000')).rejects.toThrow(/must have the "http" or "https" protocol/);
    });
    it('throws error if target is not in correct format', async () => {
        // @ts-expect-error - targetHost is deliberately omitted.
        await expect(createTunnel('http://user:password@whatever.com:12')).rejects.toThrow('Missing target hostname');
        // @ts-expect-error - targetHost is deliberately null.
        await expect(createTunnel('http://user:password@whatever.com:12', null)).rejects.toThrow('Missing target hostname');
        await expect(createTunnel('http://user:password@whatever.com:12', '')).rejects.toThrow('Missing target hostname');
        await expect(createTunnel('http://user:password@whatever.com:12', 'whatever')).rejects.toThrow('Missing target port');
        await expect(createTunnel('http://user:password@whatever.com:12', 'whatever:')).rejects.toThrow('Missing target port');
        await expect(createTunnel('http://user:password@whatever.com:12', ':whatever')).rejects.toThrow(/Invalid URL/);
    });
    it('throws error if the port option is not a valid port number', async () => {
        const proxyUrl = 'http://user:password@whatever.com:12';
        const invalidPorts = [-1, 65536, 1.5, '8080'];

        for (const port of invalidPorts) {
            // @ts-expect-error - deliberately invalid port values; validation must reject each.
            await expect(createTunnel(proxyUrl, 'localhost:9000', { port }))
                .rejects.toThrow('The "port" option must be an integer between 0 and 65535');
        }
    });
    // Regression guard for GHSA-5vwf-g8jp-pgj3: createTunnel() used to bind the unspecified address.
    describe('listener address', () => {
        // createTunnel() only parses the URLs, it never dials them, so these need no servers.
        const PROXY_URL = 'http://owner:s3cr3t@127.0.0.1:1';
        const TARGET = '127.0.0.1:1';

        let tunnel: string | undefined;

        afterEach(async () => {
            if (tunnel) await closeTunnel(tunnel, true);
            tunnel = undefined;
        });

        it('binds a loopback address by default', async () => {
            tunnel = await createTunnel(PROXY_URL, TARGET);

            expect(tunnel).toMatch(/^127\.0\.0\.1:\d+$/);
        });
        it('honours an explicit IPv6 hostname and brackets the returned endpoint', async () => {
            tunnel = await createTunnel(PROXY_URL, TARGET, { hostname: '::1' });

            expect(tunnel).toMatch(/^\[::1\]:\d+$/);
        });
        it('warns when binding a non-loopback address, but still binds it', async () => {
            const warnings: Error[] = [];
            const onWarning = (warning: Error) => warnings.push(warning);
            process.on('warning', onWarning);

            try {
                tunnel = await createTunnel(PROXY_URL, TARGET, { hostname: '0.0.0.0' });
            } finally {
                // Warnings are emitted on the next tick.
                await new Promise<void>((resolve) => setImmediate(resolve));
                process.off('warning', onWarning);
            }

            expect(tunnel).toMatch(/^0\.0\.0\.0:\d+$/);
            expect(warnings.map((warning) => warning.name)).toContain('ProxyChainSecurityWarning');
        });
        it('falls back to loopback when the hostname is blank', async () => {
            tunnel = await createTunnel(PROXY_URL, TARGET, { hostname: '' });

            expect(tunnel).toMatch(/^127\.0\.0\.1:\d+$/);
        });
        it('honours an explicit port', async () => {
            const [port] = await portastic.find(PORT_RANGES.tcpTunnelListener);
            expect(port, 'no free port in the test range').toBeDefined();

            tunnel = await createTunnel(PROXY_URL, TARGET, { port });

            expect(tunnel).toBe(`127.0.0.1:${port}`);
        });
    });
    it('correctly tunnels to tcp service and then is able to close the connection', async () => {
        const proxyServerConnections: net.Socket[] = [];

        const proxyServer = proxy(http.createServer());
        proxyServer.on('connection', (conn: net.Socket) => proxyServerConnections.push(conn));

        const targetServiceConnections: net.Socket[] = [];
        const targetService = net.createServer();
        targetService.on('connection', (conn) => {
            targetServiceConnections.push(conn);
            conn.setEncoding('utf8');
            conn.on('data', conn.write);
            conn.on('error', (err) => { throw err; });
        });

        return listenOnPort(proxyServer, 0)
            .then(async () => listenOnPort(targetService, 0))
            .then(async (targetServicePort) => {
                return createTunnel(`http://localhost:${getServerPort(proxyServer)}`, `localhost:${targetServicePort}`);
            })
            .then(async (tunnel) => closeTunnel(tunnel))
            .finally(async () => closeServerAndConnections(proxyServer, proxyServerConnections))
            .finally(async () => closeServerAndConnections(targetService, targetServiceConnections));
    });
    it('correctly tunnels to tcp service and then is able to close the connection (async/await)', async () => {
        const proxyServerConnections: net.Socket[] = [];

        const proxyServer = proxy(http.createServer());
        proxyServer.on('connection', (conn: net.Socket) => proxyServerConnections.push(conn));

        const targetServiceConnections: net.Socket[] = [];
        const targetService = net.createServer();
        targetService.on('connection', (conn) => {
            targetServiceConnections.push(conn);
            conn.setEncoding('utf8');
            conn.on('data', conn.write);
            conn.on('error', (err) => { throw err; });
        });

        try {
            await listenOnPort(proxyServer, 0);
            const targetServicePort = await listenOnPort(targetService, 0);
            const tunnel = await createTunnel(`http://localhost:${getServerPort(proxyServer)}`, `localhost:${targetServicePort}`, {});
            const result = await closeTunnel(tunnel, true);
            expect(result).toBe(true);
        } finally {
            await closeServerAndConnections(proxyServer, proxyServerConnections);
            await closeServerAndConnections(targetService, targetServiceConnections);
        }
    });
    it('creates tunnel that is able to transfer data', async () => {
        let tunnel: string;
        let response = '';
        const expected = [
            'testA',
            'testB',
            'testC',
        ];

        const proxyServerConnections: net.Socket[] = [];

        const proxyServer = proxy(http.createServer());
        proxyServer.on('connection', (conn: net.Socket) => proxyServerConnections.push(conn));

        const targetServiceConnections: net.Socket[] = [];
        const targetService = net.createServer();
        targetService.on('connection', (conn) => {
            targetServiceConnections.push(conn);
            conn.setEncoding('utf8');
            conn.on('data', conn.write);
            conn.on('error', (err) => conn.write(JSON.stringify(err)));
        });

        return listenOnPort(proxyServer, 0)
            .then(async () => listenOnPort(targetService, 0))
            .then(async (targetServicePort) => createTunnel(`http://localhost:${getServerPort(proxyServer)}`, `localhost:${targetServicePort}`))
            .then(async (newTunnel) => {
                tunnel = newTunnel;

                // Dial the host createTunnel() returned, not `localhost` - that
                // resolves to whichever family getaddrinfo happens to prefer.
                const { hostname, port } = new URL(`connect://${newTunnel}`);

                return connect(hostname, Number(port));
            })
            .then(async (connection) => {
                connection.setEncoding('utf8');
                connection.on('data', (d) => { response += d; });
                expected.forEach((text) => connection.write(`${text}\r\n`));
                return new Promise<void>((resolve) => setTimeout(() => {
                    connection.end();
                    resolve();
                }, 500));
            })
            .then(async () => {
                expect(response.trim().split('\r\n')).toStrictEqual(expected);
                return closeTunnel(tunnel);
            })
            .finally(async () => closeServerAndConnections(proxyServer, proxyServerConnections))
            .finally(async () => closeServerAndConnections(targetService, targetServiceConnections));
    });
});
