import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionStats } from '../../src/index.js';
import { Server } from '../../src/index.js';
import { closeServer, getServerPort, wait } from '../utils/test_helpers.js';

const sslKey = fs.readFileSync(path.join(import.meta.dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(import.meta.dirname, 'ssl.crt'));

/** Node surfaces the OpenSSL detail the assertions below check for on TLS errors. */
type TlsError = Error & { library?: string; reason?: string };

vi.setConfig({ testTimeout: 10_000 });

it('handles TLS handshake failures gracefully and continues accepting connections', async () => {
    const tlsErrors: TlsError[] = [];
    let server: Server | undefined;
    let badSocket: tls.TLSSocket | undefined;
    let goodSocket: tls.TLSSocket | undefined;
    let targetServer: net.Server | undefined;

    try {
        // Create a local TCP server as the CONNECT target to avoid external network dependency.
        const target = net.createServer((socket) => {
            socket.on('error', () => {});
        });
        targetServer = target;
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const targetPort = getServerPort(target);

        server = new Server({
            port: 0,
            serverType: 'https',
            httpsOptions: {
                key: sslKey,
                cert: sslCrt,
            },
        });

        server.on('tlsError', ({ error }: { error: TlsError }) => {
            tlsErrors.push(error);
        });

        await server.listen();
        const serverPort = server.port;

        // Make invalid TLS connection.
        const bad = tls.connect({
            port: serverPort,
            host: '127.0.0.1',
            rejectUnauthorized: false,
            minVersion: 'TLSv1',
            maxVersion: 'TLSv1',
        });
        badSocket = bad;

        const badSocketErrorOccurred = await new Promise<boolean>((resolve, reject) => {
            let errorOccurred = false;

            bad.on('error', () => {
                errorOccurred = true;
                // Expected: TLS handshake will fail due to version mismatch.
            });

            bad.on('close', () => {
                resolve(errorOccurred);
            });

            bad.setTimeout(5000, () => {
                bad.destroy();
                reject(new Error('Bad socket timed out before error'));
            });
        });

        await wait(100);

        expect(badSocketErrorOccurred).toBe(true);

        // Make a valid TLS connection to prove server still works.
        const good = tls.connect({
            port: serverPort,
            host: '127.0.0.1',
            rejectUnauthorized: false,
        });
        goodSocket = good;

        // Wait for secure connection.
        const goodSocketConnected = await new Promise<boolean>((resolve, reject) => {
            let isConnected = false;

            const timeout = setTimeout(() => {
                good.destroy();
                reject(new Error('Good socket connection timed out'));
            }, 5000);

            good.on('error', (err) => {
                clearTimeout(timeout);
                good.destroy();
                reject(err);
            });

            good.on('secureConnect', () => {
                isConnected = true;
                clearTimeout(timeout);
                resolve(isConnected);
            });

            good.on('close', () => {
                clearTimeout(timeout);
            });
        });

        expect(goodSocketConnected, 'Good socket should have connected').toBe(true);

        // Write the CONNECT request to local target server.
        good.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);

        const response = await new Promise<string>((resolve, reject) => {
            const goodSocketTimeout = setTimeout(() => {
                good.destroy();
                reject(new Error('Good socket connection timed out'));
            }, 5000);

            good.on('error', (err) => {
                clearTimeout(goodSocketTimeout);
                good.destroy();
                reject(err);
            });

            good.on('data', (data) => {
                clearTimeout(goodSocketTimeout);
                good.destroy();
                resolve(data.toString());
            });

            good.on('close', () => {
                clearTimeout(goodSocketTimeout);
            });
        });

        await wait(100);

        expect(response).toBe('HTTP/1.1 200 Connection Established\r\n\r\n');

        expect(tlsErrors).toHaveLength(1);
        expect(tlsErrors[0].library).toBe('SSL routines');
        // Error message varies by OpenSSL version: 'unsupported protocol' (Node 20) vs 'unexpected message' (Node 22+)
        expect(['unsupported protocol', 'unexpected message']).toContain(tlsErrors[0].reason);
    } finally {
        if (badSocket && !badSocket.destroyed) {
            badSocket.destroy();
        }
        if (goodSocket && !goodSocket.destroyed) {
            goodSocket.destroy();
        }
        if (server) {
            await server.close(true);
        }
        if (targetServer) {
            await closeServer(targetServer);
        }
    }
});

describe('HTTPS proxy server resource cleanup', () => {
    let server: Server;

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
        }
    });

    it('cleans up connections when client disconnects abruptly', async () => {
        const closedConnections: number[] = [];
        server.on('connectionClosed', ({ connectionId }: { connectionId: number }) => {
            closedConnections.push(connectionId);
        });

        const socket = tls.connect({
            port: server.port,
            host: '127.0.0.1',
            rejectUnauthorized: false,
        });

        await new Promise<void>((resolve) => socket.on('secureConnect', resolve));

        // Small delay to ensure server-side connection registration completes.
        await wait(100);

        expect(server.getConnectionIds()).toHaveLength(1);

        // Abruptly destroy the connection (simulating client crash).
        socket.destroy();

        await new Promise<void>((resolve) => socket.on('close', resolve));
        await wait(100);

        expect(server.getConnectionIds()).toHaveLength(0);
        expect(closedConnections).toHaveLength(1);
    });

    it('cleans up when client closes immediately after CONNECT 200', async () => {
        const closedConnections: { connectionId: number; stats: ConnectionStats }[] = [];
        server.on('connectionClosed', ({ connectionId, stats }: { connectionId: number; stats: ConnectionStats }) => {
            closedConnections.push({ connectionId, stats });
        });

        const socket = tls.connect({
            port: server.port,
            host: '127.0.0.1',
            rejectUnauthorized: false,
        });

        await new Promise<void>((resolve) => socket.on('secureConnect', resolve));

        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');

        await new Promise<void>((resolve, reject) => {
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

        await new Promise<void>((resolve) => socket.on('close', resolve));
        await wait(500);

        expect(server.getConnectionIds()).toHaveLength(0);
        expect(closedConnections).toHaveLength(1);
    });

    it('handles multiple HTTP requests over single TLS connection (keep-alive)', async () => {
        const targetServer = http.createServer((_, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Hello world!');
        });

        await new Promise<void>((resolve) => targetServer.listen(0, resolve));
        const targetServerPort = getServerPort(targetServer);

        try {
            const socket = tls.connect({
                port: server.port,
                host: '127.0.0.1',
                rejectUnauthorized: false,
            });

            await new Promise<void>((resolve) => socket.on('secureConnect', resolve));

            const responses: string[] = [];

            for (let i = 0; i < 3; i++) {
                socket.write(
                    `GET http://127.0.0.1:${targetServerPort}/hello-world HTTP/1.1\r\n`
                    + `Host: 127.0.0.1\r\n`
                    + `Connection: keep-alive\r\n\r\n`,
                );

                const response = await new Promise<string>((resolve) => {
                    let data = '';
                    const onData = (chunk: Buffer) => {
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
                expect(socket.destroyed).toBe(false);
                expect(server.getConnectionIds()).toHaveLength(1);
            }

            socket.destroy();

            // Wait a bit for socket cleanup.
            await wait(100);

            expect(server.getConnectionIds()).toHaveLength(0);

            expect(responses).toHaveLength(3);
            responses.forEach((r) => {
                expect(r).toContain('200 OK');
                expect(r).toContain('Hello world');
            });
        } finally {
            await closeServer(targetServer);
        }
    });

    it('handles multiple sequential TLS failures without leaking connections', async () => {
        const tlsErrors: TlsError[] = [];
        server.on('tlsError', ({ error }: { error: TlsError }) => tlsErrors.push(error));

        // 10 sequential failures (sanity check).
        for (let i = 0; i < 10; i++) {
            const badSocket = tls.connect({
                port: server.port,
                host: '127.0.0.1',
                minVersion: 'TLSv1',
                maxVersion: 'TLSv1',
            });

            await new Promise<void>((resolve) => {
                badSocket.on('error', () => {});
                badSocket.on('close', resolve);
            });
        }

        await wait(200);

        expect(tlsErrors).toHaveLength(10);
        expect(server.getConnectionIds()).toHaveLength(0);

        // Verify server still works.
        const goodSocket = tls.connect({
            port: server.port,
            host: '127.0.0.1',
            rejectUnauthorized: false,
        });

        await new Promise<void>((resolve, reject) => {
            goodSocket.on('secureConnect', resolve);
            goodSocket.on('error', reject);
        });

        goodSocket.destroy();
    });
});
