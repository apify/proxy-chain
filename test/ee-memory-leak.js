import net from 'node:net';
import http from 'node:http';
import { assert } from 'chai';
import * as ProxyChain from '../dist/index.js';

describe('ProxyChain server', () => {
    let proxyServer;
    let server;
    let port;

    before(() => {
        proxyServer = new ProxyChain.Server();

        server = http.createServer((_request, response) => {
            response.end('Hello, world!');
        }).listen(0);

        port = server.address().port;
    });

    after(() => {
        proxyServer.close();
        server.close();
    });

    it('does not leak events', async () => {
        let socket;
        let registeredCount;
        proxyServer.server.prependOnceListener('request', (request) => {
            socket = request.socket;
            registeredCount = socket.listenerCount('error');
        });

        await proxyServer.listen();
        const proxyServerPort = proxyServer.server.address().port;

        const requestCount = 20;

        const client = net.connect({
            host: 'localhost',
            port: proxyServerPort,
        });

        client.setTimeout(100);

        await new Promise((resolve) => {
            client.on('timeout', () => {
                client.destroy();
                resolve();
            });

            for (let i = 0; i < requestCount; i++) {
                client.write(`GET http://localhost:${port} HTTP/1.1\r\nhost: localhost:${port}\r\nconnection: keep-alive\r\n\r\n`);
            }
        });

        assert.equal(socket.listenerCount('error'), registeredCount);
    });
});
