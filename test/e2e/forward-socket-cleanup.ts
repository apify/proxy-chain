import http from 'node:http';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Server } from '../../src/index.js';
import { closeServer, getServerPort, listenOnPort } from '../utils/test_helpers.js';

describe('forward() socket cleanup', () => {
    let target: http.Server;
    let targetPort: number;
    let httpAgent: http.Agent;
    let proxyServer: Server | undefined;

    beforeEach(async () => {
        // Target that accepts the request but never responds, so the outbound
        // socket stays open only for as long as something keeps it open.
        target = http.createServer(() => {});
        targetPort = await listenOnPort(target);

        httpAgent = new http.Agent({ keepAlive: true });
    });

    afterEach(async () => {
        if (proxyServer) await proxyServer.close(true);
        httpAgent.destroy();
        await closeServer(target);
    });

    it('destroys the outbound socket when the client disconnects before the upstream responds', async () => {
        let targetSocket: net.Socket | undefined;
        const originalCreateConnection = httpAgent.createConnection.bind(httpAgent);
        httpAgent.createConnection = (options, callback) => {
            const socket = originalCreateConnection(options, callback) as net.Socket;
            targetSocket = socket;
            return socket;
        };

        proxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => ({ httpAgent }),
        });
        await proxyServer.listen();
        const proxyPort = getServerPort(proxyServer.server);

        const client = net.connect({ host: '127.0.0.1', port: proxyPort });
        await new Promise<void>((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
        });

        client.write(
            `GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\n`
            + `host: 127.0.0.1:${targetPort}\r\n`
            + `connection: keep-alive\r\n\r\n`,
        );

        // Wait until the outbound socket to the target actually exists.
        await new Promise<void>((resolve, reject) => {
            const interval = setInterval(() => {
                if (targetSocket) {
                    clearInterval(interval);
                    // eslint-disable-next-line no-use-before-define -- the interval and timeout clear each other.
                    clearTimeout(timeout);
                    resolve();
                }
            }, 5);
            const timeout = setTimeout(() => {
                clearInterval(interval);
                reject(new Error('Timed out waiting for httpAgent.createConnection() to be called - the outbound socket was never created.'));
            }, 2000);
        });

        if (targetSocket === undefined) throw new Error('The outbound socket was never created.');
        expect(targetSocket.destroyed).toBe(false);

        // Simulate the client (browser) disappearing while the target is
        // still hanging - e.g. graceful shutdown via server.close(true),
        // without the caller separately destroying their custom httpAgent.
        await proxyServer.close(true);

        // The outbound socket must be cleaned up as a result, not left dangling.
        await new Promise<void>((resolve) => {
            if (targetSocket!.destroyed) return resolve();
            targetSocket!.once('close', () => resolve());
        });

        expect(targetSocket!.destroyed).toBe(true);
    });
});
