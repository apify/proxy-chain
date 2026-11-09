import http from 'node:http';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Server } from '../../src/index.js';
import { closeServer, getServerPort, listenOnPort } from '../utils/test_helpers.js';

// An upstream response with both Content-Length and Transfer-Encoding must reach the client chunked, without the Content-Length.
describe('forward() response desync', () => {
    const FORGED = 'HTTP/1.1 200 OK\r\nContent-Length: 6\r\nX-Forged: yes\r\n\r\nPWNED\n';
    const BODY = `AAAAA${FORGED}`;

    let evil: net.Server;
    let evilPort: number;
    let benign: http.Server;
    let benignPort: number;
    let proxyServer: Server | undefined;

    beforeEach(async () => {
        evil = net.createServer((socket) => {
            socket.once('data', () => {
                socket.end(
                    'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n'
                    + `${BODY.length.toString(16)}\r\n${BODY}\r\n0\r\n\r\n`,
                );
            });
        });
        evilPort = await listenOnPort(evil);

        benign = http.createServer((_request, response) => {
            response.end('benign');
        });
        benignPort = await listenOnPort(benign);

        proxyServer = new Server({ port: 0 });
        await proxyServer.listen();
    });

    afterEach(async () => {
        if (proxyServer) await proxyServer.close(true);
        await closeServer(evil);
        await closeServer(benign);
    });

    const requestThroughProxy = async (agent: http.Agent, targetPort: number) => {
        return new Promise<{ headers: http.IncomingHttpHeaders, body: string }>((resolve, reject) => {
            http.get({
                host: '127.0.0.1',
                port: getServerPort(proxyServer!.server),
                path: `http://127.0.0.1:${targetPort}/`,
                headers: { host: `127.0.0.1:${targetPort}` },
                agent,
            }, (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { body += chunk; });
                response.once('end', () => resolve({ headers: response.headers, body }));
            }).once('error', reject);
        });
    };

    it('re-frames the body instead of forwarding the upstream Content-Length', async () => {
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

        try {
            const first = await requestThroughProxy(agent, evilPort);

            // The whole chunked body belongs to the first response, with no length header to split it.
            expect(first.headers['content-length']).toBeUndefined();
            expect(first.headers['transfer-encoding']).toBe('chunked');
            expect(first.body).toBe(BODY);

            // The next request on the same keep-alive connection gets its own response, not the forged one.
            const second = await requestThroughProxy(agent, benignPort);

            expect(second.headers['x-forged']).toBeUndefined();
            expect(second.body).toBe('benign');
        } finally {
            agent.destroy();
        }
    });
});
