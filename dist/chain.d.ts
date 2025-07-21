/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import type { Buffer } from 'node:buffer';
import type dns from 'node:dns';
import type { EventEmitter } from 'node:events';
import type { URL } from 'node:url';
import type { Socket } from './socket';
export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    ignoreUpstreamProxyCertificate: boolean;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
    customTag?: unknown;
}
interface ChainOpts {
    request: {
        url?: string;
    };
    sourceSocket: Socket;
    head?: Buffer;
    handlerOpts: HandlerOpts;
    server: EventEmitter & {
        log: (connectionId: unknown, str: string) => void;
    };
    isPlain: boolean;
}
/**
 * Passes the traffic to upstream HTTP proxy server.
 * Client -> Apify -> Upstream -> Web
 * Client <- Apify <- Upstream <- Web
 */
export declare const chain: ({ request, sourceSocket, head, handlerOpts, server, isPlain, }: ChainOpts) => void;
export {};
//# sourceMappingURL=chain.d.ts.map