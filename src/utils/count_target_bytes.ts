import net from 'net';

const targetBytesWritten = Symbol('targetBytesWritten');
const targetBytesRead = Symbol('targetBytesRead');
const targets = Symbol('targets');
const calculateTargetStats = Symbol('calculateTargetStats');

type Stats = { bytesWritten: number | null, bytesRead: number | null };

interface Extras {
    [targetBytesWritten]: number;
    [targetBytesRead]: number;
    [targets]: Set<net.Socket>;
    [calculateTargetStats]: () => Stats;
}

// @ts-expect-error TS is not aware that `source` is used in the assertion.
// eslint-disable-next-line @typescript-eslint/no-empty-function
function typeSocket(source: unknown): asserts source is net.Socket & Extras {};

export const countTargetBytes = (source: net.Socket, target: net.Socket): void => {
    typeSocket(source);

    source[targetBytesWritten] = source[targetBytesWritten] || 0;
    source[targetBytesRead] = source[targetBytesRead] || 0;
    source[targets] = source[targets] || new Set();

    source[targets].add(target);

    target.once('close', () => {
        source[targetBytesWritten] += target.bytesWritten;
        source[targetBytesRead] += target.bytesRead;

        source[targets].delete(target);
    });

    if (!source[calculateTargetStats]) {
        source[calculateTargetStats] = () => {
            let bytesWritten = source[targetBytesWritten];
            let bytesRead = source[targetBytesRead];

            for (const socket of source[targets]) {
                bytesWritten += socket.bytesWritten;
                bytesRead += socket.bytesRead;
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
