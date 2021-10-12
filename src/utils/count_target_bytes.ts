<<<<<<< HEAD
import type net from 'node:net';
=======
import net from 'net';
>>>>>>> f1bbe42 (release: 2.0.0 (#162))

const targetBytesWritten = Symbol('targetBytesWritten');
const targetBytesRead = Symbol('targetBytesRead');
const targets = Symbol('targets');
const calculateTargetStats = Symbol('calculateTargetStats');

type Stats = { bytesWritten: number | null, bytesRead: number | null };

<<<<<<< HEAD
/**
 * Socket object extended with previous read and written bytes.
 * Necessary due to target socket re-use.
 */
export type SocketWithPreviousStats = net.Socket & { previousBytesWritten?: number, previousBytesRead?: number };

interface Extras {
    [targetBytesWritten]: number;
    [targetBytesRead]: number;
    [targets]: Set<SocketWithPreviousStats>;
=======
interface Extras {
    [targetBytesWritten]: number;
    [targetBytesRead]: number;
    [targets]: Set<net.Socket>;
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
    [calculateTargetStats]: () => Stats;
}

// @ts-expect-error TS is not aware that `source` is used in the assertion.
// eslint-disable-next-line @typescript-eslint/no-empty-function
<<<<<<< HEAD
function typeSocket(source: unknown): asserts source is net.Socket & Extras {}

export const countTargetBytes = (
    source: net.Socket,
    target: SocketWithPreviousStats,
    registerCloseHandler?: (handler: () => void) => void,
): void => {
=======
function typeSocket(source: unknown): asserts source is net.Socket & Extras {};

export const countTargetBytes = (source: net.Socket, target: net.Socket): void => {
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
    typeSocket(source);

    source[targetBytesWritten] = source[targetBytesWritten] || 0;
    source[targetBytesRead] = source[targetBytesRead] || 0;
    source[targets] = source[targets] || new Set();

<<<<<<< HEAD
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
=======
    target.once('close', () => {
        source[targetBytesWritten] += target.bytesWritten;
        source[targetBytesRead] += target.bytesRead;

        source[targets].delete(target);
    });
>>>>>>> f1bbe42 (release: 2.0.0 (#162))

    if (!source[calculateTargetStats]) {
        source[calculateTargetStats] = () => {
            let bytesWritten = source[targetBytesWritten];
            let bytesRead = source[targetBytesRead];

            for (const socket of source[targets]) {
<<<<<<< HEAD
                bytesWritten += (socket.bytesWritten - (socket.previousBytesWritten || 0));
                bytesRead += (socket.bytesRead - (socket.previousBytesRead || 0));
=======
                bytesWritten += socket.bytesWritten;
                bytesRead += socket.bytesRead;
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
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
