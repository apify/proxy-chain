import http from 'node:http';
import net from 'node:net';
import { expect } from 'chai';

import { Server } from '../../src/index.js';

describe('forward() socket cleanup', () => {
    let target;
    let targetPort;
    let httpAgent;
    let proxyServer;

    beforeEach(async () => {
        // Target that accepts the request but never responds, so the outbound
        // socket stays open only for as long as something keeps it open.
        target = http.createServer(() => {});
        await new Promise((resolve) => target.listen(0, resolve));
        targetPort = target.address().port;

        httpAgent = new http.Agent({ keepAlive: true });
    });

    afterEach(async () => {
        if (proxyServer) await proxyServer.close(true);
        httpAgent.destroy();
        await new Promise((resolve) => target.close(resolve));
    });

    it('destroys the outbound socket when the client disconnects before the upstream responds', async () => {
        let targetSocket;
        const originalCreateConnection = httpAgent.createConnection.bind(httpAgent);
        httpAgent.createConnection = (options, callback) => {
            const socket = originalCreateConnection(options, callback);
            targetSocket = socket;
            return socket;
        };

        proxyServer = new Server({
            port: 0,
            prepareRequestFunction: () => ({ httpAgent }),
        });
        await proxyServer.listen();
        const proxyPort = proxyServer.server.address().port;

        const client = net.connect({ host: '127.0.0.1', port: proxyPort });
        await new Promise((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
        });

        client.write(
            `GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\n`
            + `host: 127.0.0.1:${targetPort}\r\n`
            + `connection: keep-alive\r\n\r\n`,
        );

        // Wait until the outbound socket to the target actually exists.
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (targetSocket) {
                    clearInterval(interval);
                    resolve();
                }
            }, 5);
        });

        expect(targetSocket.destroyed).to.be.false;

        // Simulate the client (browser) disappearing while the target is
        // still hanging - e.g. graceful shutdown via server.close(true),
        // without the caller separately destroying their custom httpAgent.
        await proxyServer.close(true);

        // The outbound socket must be cleaned up as a result, not left dangling.
        await new Promise((resolve) => {
            if (targetSocket.destroyed) return resolve();
            targetSocket.once('close', resolve);
        });

        expect(targetSocket.destroyed).to.be.true;
    });
});
