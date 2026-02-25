/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import type { Buffer } from 'node:buffer';
import type http from 'node:http';
import type net from 'node:net';
export interface AnonymizeProxyOptions {
    url: string;
    port: number;
    ignoreProxyCertificate?: boolean;
}
/**
 * Parses and validates a HTTP proxy URL. If the proxy requires authentication,
 * or if it is an HTTPS proxy and `ignoreProxyCertificate` is `true`, then the function
 * starts an open local proxy server that forwards to the upstream proxy.
 */
export declare const anonymizeProxy: (options: string | AnonymizeProxyOptions, callback?: ((error: Error | null) => void) | undefined) => Promise<string>;
/**
 * Closes anonymous proxy previously started by `anonymizeProxy()`.
 * If proxy was not found or was already closed, the function has no effect
 * and its result if `false`. Otherwise the result is `true`.
 * @param closeConnections If true, pending proxy connections are forcibly closed.
 */
export declare const closeAnonymizedProxy: (anonymizedProxyUrl: string, closeConnections: boolean, callback?: ((error: Error | null, result?: boolean) => void) | undefined) => Promise<boolean>;
type Callback = ({ response, socket, head, }: {
    response: http.IncomingMessage;
    socket: net.Socket;
    head: Buffer;
}) => void;
/**
 * Add a callback on 'tunnelConnectResponded' Event in order to get headers from CONNECT tunnel to proxy
 * Useful for some proxies that are using headers to send information like ProxyMesh
 * @returns `true` if the callback is successfully configured, otherwise `false` (e.g. when an
 * invalid proxy URL is given).
 */
export declare const listenConnectAnonymizedProxy: (anonymizedProxyUrl: string, tunnelConnectRespondedCallback: Callback) => boolean;
export {};
//# sourceMappingURL=anonymize_proxy.d.ts.map