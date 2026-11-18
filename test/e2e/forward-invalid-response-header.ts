import http from 'node:http';
import net from 'node:net';

import socksv5, { type SocksServer } from 'socksv5';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Server } from '../../src/index.js';
import { closeServer, getServerPort, listenOnPort } from '../utils/test_helpers.js';

const requestThroughProxy = async (proxyPort: number, targetPort: number): Promise<number | undefined> => {
    return new Promise((resolve, reject) => {
        http.get({
            host: '127.0.0.1',
            port: proxyPort,
            path: `http://127.0.0.1:${targetPort}/`,
            headers: { host: `127.0.0.1:${targetPort}` },
            agent: false,
        }, (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
        }).once('error', reject);
    });
};

describe('forward() with a response header rejected by Node.js', () => {
    let target: net.Server;
    let targetPort: number;
    let socksServer: SocksServer | undefined;
    let proxyServer: Server | undefined;

    beforeEach(async () => {
        // Node.js throws ERR_INVALID_CHAR from `writeHead` for a non-ASCII
        // `content-disposition` value when `content-length` is also present.
        target = net.createServer((socket) => {
            socket.once('data', () => {
                socket.end(Buffer.concat([
                    Buffer.from('HTTP/1.1 200 OK\r\ncontent-length: 6\r\ncontent-disposition: '),
                    Buffer.from([0xe0]),
                    Buffer.from('\r\n\r\nfoobar'),
                ]));
            });
        });
        targetPort = await listenOnPort(target);
    });

    afterEach(async () => {
        if (proxyServer) await proxyServer.close(true);
        proxyServer = undefined;
        if (socksServer) socksServer.close();
        socksServer = undefined;
        await closeServer(target);
    });

    it('responds with an upstream error instead of hanging', async () => {
        proxyServer = new Server({ port: 0 });
        await proxyServer.listen();

        const statusCode = await requestThroughProxy(getServerPort(proxyServer.server), targetPort);
        expect(statusCode).toBe(599);
    });

    it('responds with an upstream error instead of hanging when chained to a SOCKS proxy', async () => {
        const server = socksv5.createServer((_info, accept) => {
            accept();
        });
        socksServer = server;
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        server.useAuth(socksv5.auth.None());
        const socksPort = (server.address() as net.AddressInfo).port;

        proxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => ({ upstreamProxyUrl: `socks://127.0.0.1:${socksPort}` }),
        });
        await proxyServer.listen();

        const statusCode = await requestThroughProxy(getServerPort(proxyServer.server), targetPort);
        expect(statusCode).toBe(599);
    });
});
