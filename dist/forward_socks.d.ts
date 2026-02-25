/// <reference types="node" />
import http from 'node:http';
import type { URL } from 'node:url';
export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    localAddress?: string;
}
/**
 * Forwards HTTP requests through a SOCKS upstream proxy.
 *
 * **Note:** Custom HTTP/HTTPS agents (`httpAgent`, `httpsAgent`) from `prepareRequestFunction`
 * are not supported with SOCKS upstream proxies. SOCKS uses direct socket connections
 * managed by the SocksProxyAgent, which does not utilize HTTP agents.
 *
 * ```
 * Client -> Apify (HTTP) -> Upstream (SOCKS) -> Web
 * Client <- Apify (HTTP) <- Upstream (SOCKS) <- Web
 * ```
 */
export declare const forwardSocks: (request: http.IncomingMessage, response: http.ServerResponse, handlerOpts: HandlerOpts) => Promise<void>;
//# sourceMappingURL=forward_socks.d.ts.map