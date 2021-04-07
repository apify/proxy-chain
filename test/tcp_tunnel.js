const _ = require('underscore');
const net = require('net');
const { expect, assert } = require('chai');
const http = require('http');
const proxy = require('proxy');

const { createTunnel, closeTunnel } = require('../build/index');
const { findFreePort } = require('./tools');

const destroySocket = socket => new Promise((resolve, reject) => {
    if (!socket || socket.destroyed) return resolve();
    socket.destroy((err) => {
        if (err) return reject(err);
        return resolve();
    });
});

const serverListen = (server, port) => new Promise((resolve, reject) => {
    server.listen(port, (err) => {
        if (err) return reject(err);
        return resolve(port);
    });
});

const connect = port => new Promise((resolve, reject) => {
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

let targetService;
const targetServiceConnections = [];
let proxyServer;
const proxyServerConnections = [];
let localConnection;

after(function () {
    this.timeout(10 * 1000);
    return closeServer(proxyServer, proxyServerConnections)
        .then(() => closeServer(targetService, targetServiceConnections))
        .then(() => destroySocket(localConnection));
});

describe('tcp_tunnel.createTunnel', () => {
    it('throws error if proxyUrl is not in correct format', () => {
        assert.throws(() => { createTunnel('socks://user:password@whatever.com:123', 'localhost:9000'); }, /must have the "http" protocol/);
        assert.throws(() => { createTunnel('socks5://user:password@whatever.com', 'localhost:9000'); }, /must contain hostname and port/);
        assert.throws(() => { createTunnel('http://us%3Aer:password@whatever.com:345', 'localhost:9000'); }, /cannot contain the colon/);
    });
    it('throws error if target is not in correct format', () => {
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12'); }, /target host needs to include both/);
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', null); }, /target host needs to include both/);
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', ''); }, /target host needs to include both/);
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', 'whatever'); }, /target host needs to include both/);
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', 'whatever:'); }, /target host needs to include both/);
        assert.throws(() => { createTunnel('http://user:password@whatever.com:12', ':whatever'); }, /target host needs to include both/);
    });
    it('correctly tunnels to tcp service and then is able to close the connection', () => {
        let proxyPort;
        let servicePort;
        return findFreePort()
            .then((port) => {
                proxyServer = proxy(http.createServer());
                proxyPort = port;
                return serverListen(proxyServer, proxyPort);
            })
            .then(() => findFreePort())
            .then((port) => {
                targetService = net.createServer();
                servicePort = port;
                targetService.on('connection', (conn) => {
                    conn.setEncoding('utf8');
                    conn.on('data', conn.write);
                    conn.on('error', (err) => { throw err; });
                });
                return serverListen(targetService, servicePort);
            })
            .then(() => {
                return createTunnel(`http://localhost:${proxyPort}`, `localhost:${servicePort}`);
            })
            .then(closeTunnel);
    });
    it('correctly tunnels to tcp service and then is able to close the connection when used with callbacks', () => {
        let proxyPort;
        let servicePort;
        return findFreePort()
            .then((port) => {
                proxyServer = proxy(http.createServer());
                proxyPort = port;
                return serverListen(proxyServer, proxyPort);
            })
            .then(() => findFreePort())
            .then((port) => {
                targetService = net.createServer();
                servicePort = port;
                targetService.on('connection', (conn) => {
                    conn.setEncoding('utf8');
                    conn.on('data', conn.write);
                    conn.on('error', (err) => { throw err; });
                });
                return serverListen(targetService, servicePort);
            })
            .then(() => new Promise((resolve, reject) => {
                createTunnel(`http://localhost:${proxyPort}`, `localhost:${servicePort}`, {}, (err, tunnel) => {
                    if (err) return reject(err);
                    return resolve(tunnel);
                });
            })
            .then(tunnel => new Promise((resolve, reject) => {
                closeTunnel(tunnel, true, (err, closed) => {
                    if (err) return reject(err);
                    return resolve(closed);
                });
            })));
    });
    it('creates tunnel that is able to transfer data', () => {
        let proxyPort;
        let servicePort;
        let tunnel;
        let response = '';
        const expected = [
            'testA',
            'testB',
            'testC',
        ];
        return findFreePort()
            .then((port) => {
                proxyServer = proxy(http.createServer());
                proxyServer.on('connection', conn => proxyServerConnections.push(conn));
                proxyPort = port;
                return serverListen(proxyServer, proxyPort);
            })
            .then(() => findFreePort())
            .then((port) => {
                targetService = net.createServer();
                servicePort = port;
                targetService.on('connection', (conn) => {
                    targetServiceConnections.push(conn);
                    conn.setEncoding('utf8');
                    conn.on('data', conn.write);
                    conn.on('error', err => conn.write(JSON.stringify(err)));
                });
                return serverListen(targetService, servicePort);
            })
            .then(() => createTunnel(`http://localhost:${proxyPort}`, `localhost:${servicePort}`))
            .then((newTunnel) => {
                tunnel = newTunnel;
                const [hostname, port] = tunnel.split(':'); // eslint-disable-line
                return connect(port);
            })
            .then((connection) => {
                localConnection = connection;
                connection.setEncoding('utf8');
                connection.on('data', (d) => { response += d; });
                expected.forEach(text => connection.write(`${text}\r\n`));
                return new Promise(resolve => setTimeout(() => {
                    connection.end();
                    resolve(tunnel);
                }, 500));
            })
            .then(() => {
                expect(response.trim().split('\r\n')).to.be.deep.eql(expected);
                return closeTunnel(tunnel);
            });
    });
});
