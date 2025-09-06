/// <reference types="node" />
import http from 'node:http';
import type { URL } from 'node:url';
export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    localAddress?: string;
}
/**
 * ```
 * Client -> Apify (HTTP) -> Upstream (SOCKS) -> Web
 * Client <- Apify (HTTP) <- Upstream (SOCKS) <- Web
 * ```
 */
export declare const forwardSocks: (request: http.IncomingMessage, response: http.ServerResponse, handlerOpts: HandlerOpts) => Promise<void>;
//# sourceMappingURL=forward_socks.d.ts.map