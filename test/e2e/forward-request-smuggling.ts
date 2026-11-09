import http from 'node:http';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Server } from '../../src/index.js';
import { closeServer, getServerPort, listenOnPort, wait } from '../utils/test_helpers.js';

// Regression guard: a chunked body on a bodiless-by-default method (GET) must not be
// forwarded to the upstream as an unframed second request. See src/utils/forwarded_request_headers.ts.
describe('forward() request smuggling', () => {
    // Identifiers used only inside the absolute-form request URLs; nothing binds them.
    const ALLOWED_PORT = 30001;
    const FORBIDDEN_PORT = 30002;

    let upstream: http.Server;
    let upstreamPort: number;
    let parsedRequestUrls: string[];
    let prepareCalls: number;
    let proxyServer: Server | undefined;

    beforeEach(async () => {
        parsedRequestUrls = [];
        prepareCalls = 0;

        // Stand-in upstream proxy: records every request line it parses off the connection,
        // so a smuggled second request would show up as an extra entry.
        upstream = http.createServer((request, response) => {
            parsedRequestUrls.push(request.url ?? '');
            response.end('ok');
        });
        upstreamPort = await listenOnPort(upstream);
    });

    afterEach(async () => {
        if (proxyServer) await proxyServer.close(true);
        await closeServer(upstream);
    });

    it('does not forward a chunked GET body as a second request', async () => {
        proxyServer = new Server({
            port: 0,
            prepareRequestFunction: ({ port }) => {
                prepareCalls += 1;
                // Allowlist: permit only the carrier's port. The smuggled request never reaches here.
                if (String(port) !== String(ALLOWED_PORT)) {
                    throw new Error('blocked by allowlist');
                }
                return { upstreamProxyUrl: `http://127.0.0.1:${upstreamPort}` };
            },
        });
        await proxyServer.listen();
        const proxyPort = getServerPort(proxyServer.server);

        const smuggledRequest = `GET http://127.0.0.1:${FORBIDDEN_PORT}/ HTTP/1.1\r\n`
            + `Host: 127.0.0.1:${FORBIDDEN_PORT}\r\n\r\n`;
        const chunkSize = Buffer.byteLength(smuggledRequest).toString(16);
        const attack = `GET http://127.0.0.1:${ALLOWED_PORT}/ HTTP/1.1\r\n`
            + `Host: 127.0.0.1:${ALLOWED_PORT}\r\n`
            + `Transfer-Encoding: chunked\r\n\r\n`
            + `${chunkSize}\r\n${smuggledRequest}\r\n0\r\n\r\n`;

        const client = net.connect({ host: '127.0.0.1', port: proxyPort });
        await new Promise<void>((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
        });

        const carrierResponded = new Promise<void>((resolve) => client.once('data', () => resolve()));
        client.write(attack);
        await carrierResponded;

        // Give any smuggled second request time to be parsed by the upstream before asserting.
        await wait(100);
        client.destroy();

        // The upstream must have parsed exactly one request - the carrier - and never the forbidden one.
        expect(parsedRequestUrls).toEqual([`http://127.0.0.1:${ALLOWED_PORT}/`]);
        expect(prepareCalls).toBe(1);
    });
});
