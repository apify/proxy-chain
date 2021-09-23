const targetBytesWritten = Symbol('targetBytesWritten');
const targetBytesRead = Symbol('targetBytesRead');
const targets = Symbol('targets');
const calculateTargetStats = Symbol('calculateTargetStats');

const countTargetBytes = (source, target) => {
    source[targetBytesWritten] = source[targetBytesWritten] || 0;
    source[targetBytesRead] = source[targetBytesRead] || 0;
    source[targets] = source[targets] || new Set();

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

const getTargetStats = (socket) => {
    if (socket[calculateTargetStats]) {
        return socket[calculateTargetStats]();
    }

    return {
        bytesWritten: null,
        bytesRead: null,
    };
};

module.exports.countTargetBytes = countTargetBytes;
module.exports.getTargetStats = getTargetStats;
