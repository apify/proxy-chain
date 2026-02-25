/// <reference types="node" />
import type net from 'node:net';
type Stats = {
    bytesWritten: number | null;
    bytesRead: number | null;
};
/**
 * Socket object extended with previous read and written bytes.
 * Necessary due to target socket re-use.
 */
export type SocketWithPreviousStats = net.Socket & {
    previousBytesWritten?: number;
    previousBytesRead?: number;
};
export declare const countTargetBytes: (source: net.Socket, target: SocketWithPreviousStats, registerCloseHandler?: ((handler: () => void) => void) | undefined) => void;
export declare const getTargetStats: (socket: net.Socket) => Stats;
export {};
//# sourceMappingURL=count_target_bytes.d.ts.map