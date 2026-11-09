import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';

import portastic from 'portastic';
import { afterEach, describe, expect, it } from 'vitest';

import { Server } from '../../src/index.js';
import { httpRequest } from '../utils/http_client.js';
import { PORT_RANGES } from '../utils/port_ranges.js';
import { TargetServer } from '../utils/target_server.js';
import { takePort } from '../utils/test_helpers.js';

// Self-signed test certificate with localhost, 127.0.0.1 and ::1 subjectAltNames.
const key = fs.readFileSync(path.join(import.meta.dirname, 'upstream_tls.key'));
const cert = fs.readFileSync(path.join(import.meta.dirname, 'upstream_tls.crt'));

describe('HTTPS upstream certificate identity', () => {
    let upstream: Server | undefined;
    let proxy: Server | undefined;
    let target: TargetServer | undefined;
    let agent: https.Agent | undefined;

    afterEach(async () => {
        if (proxy) await proxy.close(true);
        if (upstream) await upstream.close(true);
        if (target) await target.close();
        agent?.destroy();
    });

    it.each([
        ['localhost', 'localhost', false],
        ['127.0.0.1', false, false],
        // Also cover the explicit certificate opt-out with an IPv6 upstream.
        ['[::1]', false, true],
    ] as const)('uses upstream %s (SNI %s; ignore certificate errors %s)', async (hostname, expectedServername, ignoreCertificateErrors) => {
        const ports = await portastic.find(PORT_RANGES.httpsUpstreamIdentity);
        target = new TargetServer({ port: takePort(ports), useSsl: true, sslKey: key, sslCrt: cert });
        await target.listen();

        let servername: string | false | null | undefined;
        let upstreamHost: string | undefined;
        let upstreamAuthorization: string | undefined;
        upstream = new Server({
            port: takePort(ports),
            host: '::',
            serverType: 'https',
            httpsOptions: { key, cert },
            prepareRequestFunction: ({ request, username, password }) => {
                upstreamHost = request.headers.host;
                upstreamAuthorization = `${username}:${password}`;
                return {
                    // The connection uses the callback overload; promisify is not used.
                    dnsLookup: ((targetHostname, options, callback) => dns.lookup(
                        targetHostname === 'target.example' ? '127.0.0.1' : targetHostname,
                        options as dns.LookupOptions,
                        callback as (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void,
                    )) as typeof dns.lookup,
                };
            },
        });
        upstream.server.on('secureConnection', (socket: TLSSocket) => {
            servername = socket.servername;
        });
        await upstream.listen();

        agent = new https.Agent({ ca: cert });
        proxy = new Server({
            port: takePort(ports),
            prepareRequestFunction: () => ({
                upstreamProxyUrl: `https://user:password@${hostname}:${upstream!.port}`,
                httpsAgent: agent,
                ignoreUpstreamProxyCertificate: ignoreCertificateErrors,
            }),
        });
        await proxy.listen();

        // Target trust is independent of the CA on the upstream's httpsAgent.
        const response = await httpRequest({
            url: `https://target.example:${target.port}/hello-world`,
            proxyUrl: `http://localhost:${proxy.port}`,
            ignoreCertificateErrors: true,
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe('Hello world!');
        expect(servername).toBe(expectedServername);
        expect(upstreamHost).toBe(`target.example:${target.port}`);
        expect(upstreamAuthorization).toBe('user:password');
    });

    it.each([
        ['wrong.example', true],
        ['localhost', false],
    ] as const)('rejects %s when upstream trust is %s', async (hostname, trustCertificate) => {
        const ports = await portastic.find(PORT_RANGES.httpsUpstreamIdentity);
        let upstreamRequests = 0;
        upstream = new Server({
            port: takePort(ports),
            serverType: 'https',
            httpsOptions: { key, cert },
            prepareRequestFunction: () => {
                upstreamRequests++;
                return {};
            },
        });
        await upstream.listen();
        agent = new https.Agent(trustCertificate ? { ca: cert } : {});
        proxy = new Server({
            port: takePort(ports),
            prepareRequestFunction: () => ({
                upstreamProxyUrl: `https://${hostname}:${upstream!.port}`,
                httpsAgent: agent,
                dnsLookup: ((_hostname, options, callback) => dns.lookup(
                    '127.0.0.1',
                    options as dns.LookupOptions,
                    callback as (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void,
                )) as typeof dns.lookup,
            }),
        });
        await proxy.listen();
        await expect(httpRequest({
            url: 'https://target.example/hello-world',
            proxyUrl: `http://localhost:${proxy.port}`,
            ignoreCertificateErrors: true,
        })).rejects.toThrow('Proxy response (599)');
        expect(upstreamRequests).toBe(0);
    });

});
