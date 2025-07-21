/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import type { Buffer } from 'node:buffer';
import type { EventEmitter } from 'node:events';
import type http from 'node:http';
import { URL } from 'node:url';
import type { Socket } from './socket';
export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    customTag?: unknown;
}
interface ChainSocksOpts {
    request: http.IncomingMessage;
    sourceSocket: Socket;
    head: Buffer;
    server: EventEmitter & {
        log: (connectionId: unknown, str: string) => void;
    };
    handlerOpts: HandlerOpts;
}
/**
 * Client -> Apify (CONNECT) -> Upstream (SOCKS) -> Web
 * Client <- Apify (CONNECT) <- Upstream (SOCKS) <- Web
 */
export declare const chainSocks: ({ request, sourceSocket, head, server, handlerOpts, }: ChainSocksOpts) => Promise<void>;
export {};
//# sourceMappingURL=chain_socks.d.ts.map