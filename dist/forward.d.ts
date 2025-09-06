/// <reference types="node" />
/// <reference types="node" />
import type dns from 'node:dns';
import http from 'node:http';
import type { URL } from 'node:url';
export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    ignoreUpstreamProxyCertificate: boolean;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
}
/**
 * The request is read from the client and is resent.
 * This is similar to Direct / Chain, however it uses the CONNECT protocol instead.
 * Forward uses standard HTTP methods.
 *
 * ```
 * Client -> Apify (HTTP) -> Web
 * Client <- Apify (HTTP) <- Web
 * ```
 *
 * or
 *
 * ```
 * Client -> Apify (HTTP) -> Upstream (HTTP) -> Web
 * Client <- Apify (HTTP) <- Upstream (HTTP) <- Web
 * ```
 */
export declare const forward: (request: http.IncomingMessage, response: http.ServerResponse, handlerOpts: HandlerOpts) => Promise<void>;
//# sourceMappingURL=forward.d.ts.map