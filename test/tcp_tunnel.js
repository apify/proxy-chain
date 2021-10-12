const net = require('net');
const { expect, assert } = require('chai');
const http = require('http');
const proxy = require('proxy');

const { createTunnel, closeTunnel } = require('../src/index');

const destroySocket = (socket) => new Promise((resolve, reject) => {
    if (!socket || socket.destroyed) return resolve();
    socket.destroy((err) => {
        if (err) return reject(err);
        return resolve();
    });
});

const serverListen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(port, () => {
        server.off('error', reject);

        resolve(server.address().port);
    });
});

const connect = (port) => new Promise((resolve, reject) => {
    const socket = net.connect({ port }, (err) => {
        if (err) return reject(err);
        return resolve(socket);
    });
});

const closeServer = (server, connections) => new Promise((resolve, reject) => {
    if (!server || !server.listening) return resolve();
    Promise.all(connections, destroySocket).then(() => {
        server.close((err) => {
            if (err) return reject(err);
            return resolve();
        });
    });
});

describe('tcp_tunnel.createTunnel', () => {
    it('throws error if proxyUrl is not in correct format', () => {
        assert.throws(() => { createTunnel('socks://user:password@whatever.com:123', 'localhost:9000'); }, /must have the "http" protocol/);
        assert.throws(() => { createTunnel('socks5://user:password@whatever.com', 'localhost:9000'); }, /must have the "http" protocol/);
    });
    it('throws error if target is not in correct format', () => {
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12'); }, 'Missing target hostname');
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', null); }, 'Missing target hostname');
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', ''); }, 'Missing target hostname');
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', 'whatever'); }, 'Missing target port');
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', 'whatever:'); }, 'Missing target port');
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', ':whatever'); }, /Invalid URL/);
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
    it('correctly tunnels to tcp service and then is able to close the connection when used with callbacks', () => {
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
            .then((targetServicePort) => new Promise((resolve, reject) => {
                createTunnel(`http://localhost:${proxyServer.address().port}`, `localhost:${targetServicePort}`, {}, (err, tunnel) => {
                    if (err) return reject(err);
                    return resolve(tunnel);
                });
            }).then((tunnel) => closeTunnel(tunnel, true))
                .then((result) => {
                    assert.equal(result, true);
                }))
            .finally(() => closeServer(proxyServer, proxyServerConnections))
            .finally(() => closeServer(targetService, targetServiceConnections));
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

                const { port } = new URL(`connect://${newTunnel}`);

                return connect(port);
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
