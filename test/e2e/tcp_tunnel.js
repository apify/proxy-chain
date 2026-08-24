import net from 'node:net';
import { expect, assert } from 'chai';
import http from 'node:http';
import proxy from 'proxy';
import portastic from 'portastic';

import { createTunnel, closeTunnel } from '../../src/index.js';
import { expectThrowsAsync } from '../utils/throws_async.js';

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
    it('throws error if proxyUrl is not in correct format', () => {
        expectThrowsAsync(async () => { await createTunnel('socks://user:password@whatever.com:123', 'localhost:9000'); }, /must have the "http" protocol/);
        expectThrowsAsync(async () => { await createTunnel('socks5://user:password@whatever.com', 'localhost:9000'); }, /must have the "http" protocol/);
    });
    it('throws error if target is not in correct format', () => {
        expectThrowsAsync(async () => { await createTunnel('http://user:password@whatever.com:12'); }, 'Missing target hostname');
        expectThrowsAsync(async () => { await createTunnel('http://user:password@whatever.com:12', null); }, 'Missing target hostname');
        expectThrowsAsync(async () => { await createTunnel('http://user:password@whatever.com:12', ''); }, 'Missing target hostname');
        expectThrowsAsync(async () => { await createTunnel('http://user:password@whatever.com:12', 'whatever'); }, 'Missing target port');
        expectThrowsAsync(async () => { await createTunnel('http://user:password@whatever.com:12', 'whatever:'); }, 'Missing target port');
        expectThrowsAsync(async () => { await createTunnel('http://user:password@whatever.com:12', ':whatever'); }, /Invalid URL/);
    });
    it('throws error if the port option is not a valid port number', async () => {
        const proxyUrl = 'http://user:password@whatever.com:12';
        const invalidPorts = [-1, 65536, 1.5, '8080'];

        for (const port of invalidPorts) {
            await expectThrowsAsync(
                async () => { await createTunnel(proxyUrl, 'localhost:9000', { port }); },
                'The "port" option must be an integer between 0 and 65535',
            );
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

            expect(tunnel).to.match(/^127\.0\.0\.1:\d+$/);
        });
        it('honours an explicit IPv6 hostname and brackets the returned endpoint', async () => {
            tunnel = await createTunnel(PROXY_URL, TARGET, { hostname: '::1' });

            expect(tunnel).to.match(/^\[::1\]:\d+$/);
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

            expect(tunnel).to.match(/^0\.0\.0\.0:\d+$/);
            expect(warnings.map((warning) => warning.name)).to.include('ProxyChainSecurityWarning');
        });
        it('falls back to loopback when the hostname is blank', async () => {
            tunnel = await createTunnel(PROXY_URL, TARGET, { hostname: '' });

            expect(tunnel).to.match(/^127\.0\.0\.1:\d+$/);
        });
        it('honours an explicit port', async () => {
            const [port] = await portastic.find({ min: 50750, max: 51000 });
            assert.isDefined(port, 'no free port in the test range');

            tunnel = await createTunnel(PROXY_URL, TARGET, { port });

            expect(tunnel).to.equal(`127.0.0.1:${port}`);
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
            assert.equal(result, true);
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
                expect(response.trim().split('\r\n')).to.be.deep.eql(expected);
                return closeTunnel(tunnel);
            })
            .finally(() => closeServer(proxyServer, proxyServerConnections))
            .finally(() => closeServer(targetService, targetServiceConnections));
    });
});
