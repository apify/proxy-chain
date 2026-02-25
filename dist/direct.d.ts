/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import type { Buffer } from 'node:buffer';
import type dns from 'node:dns';
import type { EventEmitter } from 'node:events';
import type { Socket } from './socket';
export interface HandlerOpts {
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
}
interface DirectOpts {
    request: {
        url?: string;
    };
    sourceSocket: Socket;
    head: Buffer;
    server: EventEmitter & {
        log: (connectionId: unknown, str: string) => void;
    };
    handlerOpts: HandlerOpts;
}
/**
 * Directly connects to the target.
 * Client -> Apify (CONNECT) -> Web
 * Client <- Apify (CONNECT) <- Web
 */
export declare const direct: ({ request, sourceSocket, head, server, handlerOpts, }: DirectOpts) => void;
export {};
//# sourceMappingURL=direct.d.ts.map