import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import proxy from 'proxy';
import portastic from 'portastic';

import { createTunnel, closeTunnel } from '../../src/index.js';
import { PORT_RANGES } from '../utils/port_ranges.js';

const destroySocket = (socket) => new Promise((resolve) => {
    if (!socket || socket.destroyed) return resolve();
    socket.once('close', () => resolve());
    socket.destroy();
});

const serverListen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(port, () => {
        server.off('error', reject);

        resolve(server.address().port);
    });
});

const connect = (host, port) => new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, (err) => {
        if (err) return reject(err);
        return resolve(socket);
    });
});

const closeServer = async (server, connections) => {
    if (!server || !server.listening) return;
    await Promise.all(connections.map(destroySocket));
    await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
};

describe('tcp_tunnel.createTunnel', () => {
    it('throws error if proxyUrl is not in correct format', async () => {
        await expect(createTunnel('socks://user:password@whatever.com:123', 'localhost:9000')).rejects.toThrow(/must have the "http" or "https" protocol/);
        await expect(createTunnel('socks5://user:password@whatever.com', 'localhost:9000')).rejects.toThrow(/must have the "http" or "https" protocol/);
    });
    it('throws error if target is not in correct format', async () => {
        await expect(createTunnel('http://user:password@whatever.com:12')).rejects.toThrow('Missing target hostname');
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
            await expect(createTunnel(proxyUrl, 'localhost:9000', { port }))
                .rejects.toThrow('The "port" option must be an integer between 0 and 65535');
        }
    });
    // Regression guard for GHSA-5vwf-g8jp-pgj3: createTunnel() used to bind the unspecified address.
    describe('listener address', () => {
        // createTunnel() only parses the URLs, it never dials them, so these need no servers.
        const PROXY_URL = 'http://owner:s3cr3t@127.0.0.1:1';
        const TARGET = '127.0.0.1:1';

        let tunnel;

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
            const warnings = [];
            const onWarning = (warning) => warnings.push(warning);
            process.on('warning', onWarning);

            try {
                tunnel = await createTunnel(PROXY_URL, TARGET, { hostname: '0.0.0.0' });
            } finally {
                // Warnings are emitted on the next tick.
                await new Promise((resolve) => setImmediate(resolve));
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
    it('correctly tunnels to tcp service and then is able to close the connection', () => {
        const proxyServerConnections = [];

        const proxyServer = proxy(http.createServer());
        proxyServer.on('connection', (conn) => proxyServerConnections.push(conn));

        const targetServiceConnections = [];
        const targetService = net.createServer();
        targetService.on('connection', (conn) => {
            targetServiceConnections.push(conn);
            conn.setEncoding('utf8');
            conn.on('data', conn.write);
            conn.on('error', (err) => { throw err; });
        });

        return serverListen(proxyServer, 0)
            .then(() => serverListen(targetService, 0))
            .then((targetServicePort) => {
                return createTunnel(`http://localhost:${proxyServer.address().port}`, `localhost:${targetServicePort}`);
            })
            .then(closeTunnel)
            .finally(() => closeServer(proxyServer, proxyServerConnections))
            .finally(() => closeServer(targetService, targetServiceConnections));
    });
    it('correctly tunnels to tcp service and then is able to close the connection (async/await)', async () => {
        const proxyServerConnections = [];

        const proxyServer = proxy(http.createServer());
        proxyServer.on('connection', (conn) => proxyServerConnections.push(conn));

        const targetServiceConnections = [];
        const targetService = net.createServer();
        targetService.on('connection', (conn) => {
            targetServiceConnections.push(conn);
            conn.setEncoding('utf8');
            conn.on('data', conn.write);
            conn.on('error', (err) => { throw err; });
        });

        try {
            await serverListen(proxyServer, 0);
            const targetServicePort = await serverListen(targetService, 0);
            const tunnel = await createTunnel(`http://localhost:${proxyServer.address().port}`, `localhost:${targetServicePort}`, {});
            const result = await closeTunnel(tunnel, true);
            expect(result).toBe(true);
        } finally {
            await closeServer(proxyServer, proxyServerConnections);
            await closeServer(targetService, targetServiceConnections);
        }
    });
    it('creates tunnel that is able to transfer data', () => {
        let tunnel;
        let response = '';
        const expected = [
            'testA',
            'testB',
            'testC',
        ];

        const proxyServerConnections = [];

        const proxyServer = proxy(http.createServer());
        proxyServer.on('connection', (conn) => proxyServerConnections.push(conn));

        const targetServiceConnections = [];
        const targetService = net.createServer();
        targetService.on('connection', (conn) => {
            targetServiceConnections.push(conn);
            conn.setEncoding('utf8');
            conn.on('data', conn.write);
            conn.on('error', (err) => conn.write(JSON.stringify(err)));
        });

        return serverListen(proxyServer, 0)
            .then(() => serverListen(targetService, 0))
            .then((targetServicePort) => createTunnel(`http://localhost:${proxyServer.address().port}`, `localhost:${targetServicePort}`))
            .then((newTunnel) => {
                tunnel = newTunnel;

                // Dial the host createTunnel() returned, not `localhost` - that
                // resolves to whichever family getaddrinfo happens to prefer.
                const { hostname, port } = new URL(`connect://${newTunnel}`);

                return connect(hostname, port);
            })
            .then((connection) => {
                connection.setEncoding('utf8');
                connection.on('data', (d) => { response += d; });
                expected.forEach((text) => connection.write(`${text}\r\n`));
                return new Promise((resolve) => setTimeout(() => {
                    connection.end();
                    resolve(tunnel);
                }, 500));
            })
            .then(() => {
                expect(response.trim().split('\r\n')).toStrictEqual(expected);
                return closeTunnel(tunnel);
            })
            .finally(() => closeServer(proxyServer, proxyServerConnections))
            .finally(() => closeServer(targetService, targetServiceConnections));
    });
});
