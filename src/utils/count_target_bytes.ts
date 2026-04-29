import type net from 'node:net';

const targetBytesWritten = Symbol('targetBytesWritten');
const targetBytesRead = Symbol('targetBytesRead');
const targets = Symbol('targets');
const calculateTargetStats = Symbol('calculateTargetStats');

type Stats = { bytesWritten: number | null, bytesRead: number | null };

/**
 * Socket object extended with previous read and written bytes.
 * Necessary due to target socket re-use.
 */
export type SocketWithPreviousStats = net.Socket & { previousBytesWritten?: number, previousBytesRead?: number };

interface Extras {
    [targetBytesWritten]: number;
    [targetBytesRead]: number;
    [targets]: Set<SocketWithPreviousStats>;
    [calculateTargetStats]: () => Stats;
}

export const countTargetBytes = (
    sourceSocket: net.Socket,
    target: SocketWithPreviousStats,
    registerCloseHandler?: (handler: () => void) => void,
): void => {
    const source = sourceSocket as net.Socket & Extras;

    source[targetBytesWritten] = source[targetBytesWritten] || 0;
    source[targetBytesRead] = source[targetBytesRead] || 0;
    source[targets] = source[targets] || new Set();

    source[targets].add(target);

    const closeHandler = () => {
        source[targetBytesWritten] += (target.bytesWritten - (target.previousBytesWritten || 0));
        source[targetBytesRead] += (target.bytesRead - (target.previousBytesRead || 0));
        source[targets].delete(target);
    };
    if (!registerCloseHandler) {
        registerCloseHandler = (handler: () => void) => target.once('close', handler);
    }
    registerCloseHandler(closeHandler);

    if (!source[calculateTargetStats]) {
        source[calculateTargetStats] = () => {
            let bytesWritten = source[targetBytesWritten];
            let bytesRead = source[targetBytesRead];

            for (const socket of source[targets]) {
                bytesWritten += (socket.bytesWritten - (socket.previousBytesWritten || 0));
                bytesRead += (socket.bytesRead - (socket.previousBytesRead || 0));
            }

            return {
                bytesWritten,
                bytesRead,
            };
        };
    }
};

export const getTargetStats = (rawSocket: net.Socket): Stats => {
    const socket = rawSocket as net.Socket & Extras;

    if (socket[calculateTargetStats]) {
        return socket[calculateTargetStats]();
    }

    return {
        bytesWritten: null,
        bytesRead: null,
    };
};
