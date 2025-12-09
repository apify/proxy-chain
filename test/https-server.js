const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { expect } = require('chai');
const http = require('http');
const { Server } = require('../src/index');

const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

const wait = (timeout) => new Promise((resolve) => setTimeout(resolve, timeout));

it('handles TLS handshake failures gracefully and continues accepting connections', async function () {
    this.timeout(10000);

    const tlsErrors = [];

    let server = new Server({
        port: 0,
        serverType: 'https',
        httpsOptions: {
            key: sslKey,
            cert: sslCrt,
        },
    });

    server.on('tlsError', ({ error }) => {
        tlsErrors.push(error);
    });

    await server.listen();
    const serverPort = server.port;

    // Make invalid TLS connection.
    const badSocket = tls.connect({
        port: serverPort,
        host: '127.0.0.1',
        rejectUnauthorized: false,
        minVersion: 'TLSv1',
        maxVersion: 'TLSv1',
    });

    const badSocketErrorOccurred = await new Promise((resolve, reject) => {
        let errorOccurred = false;

        badSocket.on('error', () => {
            errorOccurred = true;
            // Expected: TLS handshake will fail due to version mismatch.
        });

        badSocket.on('close', () => {
            resolve(errorOccurred);
        });

        badSocket.setTimeout(5000, () => {
            badSocket.destroy();
            reject(new Error('Bad socket timed out before error'));
        });

    });

    await wait(100);

    expect(badSocketErrorOccurred).to.equal(true);

    // Make a valid TLS connection to prove server still works.
    const goodSocket = tls.connect({
        port: serverPort,
        host: '127.0.0.1',
        rejectUnauthorized: false,
    });

    // Wait for secure connection.
    const goodSocketConnected = await new Promise((resolve, reject) => {
        let isConnected = false;

        const timeout = setTimeout(() => {
            goodSocket.destroy();
            reject(new Error('Good socket connection timed out'));
        }, 5000);

        goodSocket.on('error', (err) => {
            clearTimeout(timeout);
            goodSocket.destroy();
            reject(err);
        });

        goodSocket.on('secureConnect', () => {
            isConnected = true;
            clearTimeout(timeout);
            resolve(isConnected);
        });

        goodSocket.on('close', () => {
            clearTimeout(timeout);
        });
    });

    expect(goodSocketConnected).to.equal(true, 'Good socket should have connected');

    // Write the CONNECT request.
    goodSocket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');

    const response = await new Promise((resolve, reject) => {
        const goodSocketTimeout = setTimeout(() => {
            goodSocket.destroy();
            reject(new Error('Good socket connection timed out'));
        }, 5000);

        goodSocket.on('error', (err) => {
            clearTimeout(goodSocketTimeout);
            goodSocket.destroy();
            reject(err);
        });

        goodSocket.on('data', (data) => {
            clearTimeout(goodSocketTimeout);
            goodSocket.destroy();
            resolve(data.toString());
        });

        goodSocket.on('close', () => {
            clearTimeout(goodSocketTimeout);
        });
    });

    await wait(100);

    expect(response).to.be.equal('HTTP/1.1 200 Connection Established\r\n\r\n');

    expect(tlsErrors.length).to.be.equal(1);
    expect(tlsErrors[0].library).to.be.equal('SSL routines');
    expect(tlsErrors[0].reason).to.be.equal('unsupported protocol');
    expect(tlsErrors[0].code).to.be.equal('ERR_SSL_UNSUPPORTED_PROTOCOL');

    // Cleanup.
    server.close(true);
    server = null;
});

describe('HTTPS proxy server resource cleanup', () => {
    let server;

    beforeEach(async () => {
        server = new Server({
            port: 0,
            serverType: 'https',
            httpsOptions: {
                key: sslKey,
                cert: sslCrt,
            },
        });
        await server.listen();
    });

    afterEach(async () => {
        if (server) {
            await server.close(true);
            server = null;
        }
    });

    it('cleans up connections when client disconnects abruptly', async function () {
        this.timeout(5000);

        const closedConnections = [];
        server.on('connectionClosed', ({ connectionId }) => {
            closedConnections.push(connectionId);
        });

        const socket = tls.connect({
            port: server.port,
            host: '127.0.0.1',
            rejectUnauthorized: false,
        });

        await new Promise((resolve) => socket.on('secureConnect', resolve));

        // Small delay to ensure server-side connection registration completes.
        await wait(100);

        const connectionsBefore = server.getConnectionIds().length;
        expect(connectionsBefore).to.equal(1);

        // Abruptly destroy the connection (simulating client crash).
        socket.destroy();

        await new Promise((resolve) => socket.on('close', resolve));
        await wait(100);

        expect(server.getConnectionIds()).to.be.empty;
        expect(closedConnections.length).to.equal(1);
    });

    it('cleans up when client closes immediately after CONNECT 200', async function () {
        this.timeout(5000);

        const closedConnections = [];
        server.on('connectionClosed', ({ connectionId, stats }) => {
            closedConnections.push({ connectionId, stats });
        });

        const socket = tls.connect({
            port: server.port,
            host: '127.0.0.1',
            rejectUnauthorized: false,
        });

        await new Promise((resolve) => socket.on('secureConnect', resolve));

        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout waiting for CONNECT response')), 3000);

            socket.on('data', (data) => {
                if (data.toString().includes('200')) {
                    clearTimeout(timeout);
                    socket.destroy(); // Abrupt close.
                    resolve();
                }
            });

            socket.on('error', () => {});
        });

        await new Promise((resolve) => socket.on('close', resolve));
        await wait(500);

        expect(server.getConnectionIds()).to.be.empty;
        expect(closedConnections.length).to.equal(1);
    });

    it('handles multiple HTTP requests over single TLS connection (keep-alive)', async function () {
        this.timeout(10000);

        const targetServer = http.createServer((_, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Hello world!');
        });

        await new Promise((resolve) => targetServer.listen(0, resolve));
        const targetServerPort = targetServer.address().port;

        try {
            const socket = tls.connect({
                port: server.port,
                host: '127.0.0.1',
                rejectUnauthorized: false,
            });

            await new Promise((resolve) => socket.on('secureConnect', resolve));

            const responses = [];

            for (let i = 0; i < 3; i++) {
                socket.write(
                    `GET http://127.0.0.1:${targetServerPort}/hello-world HTTP/1.1\r\n` +
                    `Host: 127.0.0.1\r\n` +
                    `Connection: keep-alive\r\n\r\n`
                );

                const response = await new Promise((resolve) => {
                    let data = '';
                    const onData = (chunk) => {
                        data += chunk.toString();
                        if (data.includes('Hello world')) {
                            socket.removeListener('data', onData);
                            resolve(data);
                        }
                    };
                    socket.on('data', onData);
                });

                responses.push(response);

                // Verify keep-alive: socket still alive, exactly one connection.
                expect(socket.destroyed).to.equal(false);
                expect(server.getConnectionIds().length).to.equal(1);
            }

            socket.destroy();

            // Wait a bit for socket cleanup.
            await wait(100);

            expect(server.getConnectionIds().length).to.equal(0);

            expect(responses.length).to.equal(3);
            responses.forEach((r) => {
                expect(r).to.include('200 OK');
                expect(r).to.include('Hello world');
            });
        } finally {
            await new Promise((resolve) => targetServer.close(resolve));
        }
    });

    it('handles multiple sequential TLS failures without leaking connections', async function () {
        this.timeout(10000);

        const tlsErrors = [];
        server.on('tlsError', ({ error }) => tlsErrors.push(error));

        // 10 sequential failures (sanity check).
        for (let i = 0; i < 10; i++) {
            const badSocket = tls.connect({
                port: server.port,
                host: '127.0.0.1',
                minVersion: 'TLSv1',
                maxVersion: 'TLSv1',
            });

            await new Promise((resolve) => {
                badSocket.on('error', () => {});
                badSocket.on('close', resolve);
            });
        }

        await wait(200);

        expect(tlsErrors.length).to.equal(10);
        expect(server.getConnectionIds()).to.be.empty;

        // Verify server still works.
        const goodSocket = tls.connect({
            port: server.port,
            host: '127.0.0.1',
            rejectUnauthorized: false,
        });

        await new Promise((resolve, reject) => {
            goodSocket.on('secureConnect', resolve);
            goodSocket.on('error', reject);
        });

        goodSocket.destroy();
    });
});
