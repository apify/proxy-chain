import http from 'node:http';
import net from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as ProxyChain from '../../src/index.js';
import { closeServer, getServerPort } from '../utils/test_helpers.js';

describe('ProxyChain server', () => {
    let server: http.Server;
    let port: number;

    beforeAll(() => {
        server = http.createServer((_request, response) => {
            response.end('Hello, world!');
        }).listen(0);

        port = getServerPort(server);
    });

    afterAll(async () => {
        await closeServer(server);
    });

    it('does not leak events', async () => {
        const proxyServer = new ProxyChain.Server();

        try {
            let socket: net.Socket | undefined;
            let registeredCount: number | undefined;
            proxyServer.server.prependOnceListener('request', (request: http.IncomingMessage) => {
                socket = request.socket;
                registeredCount = socket.listenerCount('error');
            });

            await proxyServer.listen();
            const proxyServerPort = getServerPort(proxyServer.server);

            const requestCount = 20;

            const client = net.connect({
                host: 'localhost',
                port: proxyServerPort,
            });

            client.setTimeout(100);

            await new Promise<void>((resolve) => {
                client.on('timeout', () => {
                    client.destroy();
                    resolve();
                });

                for (let i = 0; i < requestCount; i++) {
                    client.write(`GET http://localhost:${port} HTTP/1.1\r\nhost: localhost:${port}\r\nconnection: keep-alive\r\n\r\n`);
                }
            });

            if (socket === undefined) throw new Error('The proxy server never received a request.');
            expect(socket.listenerCount('error')).toBe(registeredCount);
        } finally {
            await proxyServer.close(true);
        }
    });
});
