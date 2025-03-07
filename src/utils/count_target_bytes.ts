import type net from 'net';

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

// @ts-expect-error TS is not aware that `source` is used in the assertion.
function typeSocket(source: unknown): asserts source is net.Socket & Extras {}

export const countTargetBytes = (
    source: net.Socket,
    target: SocketWithPreviousStats,
    registerCloseHandler?: (handler: () => void) => void,
): void => {
    typeSocket(source);

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

export const getTargetStats = (socket: net.Socket): Stats => {
    typeSocket(socket);

    if (socket[calculateTargetStats]) {
        return socket[calculateTargetStats]();
    }

    return {
        bytesWritten: null,
        bytesRead: null,
    };
};
