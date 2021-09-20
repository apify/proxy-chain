const targetBytesWritten = Symbol('targetBytesWritten');
const targetBytesReceived = Symbol('targetBytesReceived');
const targets = Symbol('targets');
const calculateTargetStats = Symbol('calculateTargetStats');

const countTargetBytes = (source, target) => {
    source[targetBytesWritten] = source[targetBytesWritten] || 0;
    source[targetBytesReceived] = source[targetBytesReceived] || 0;
    source[targets] = source[targets] || new Set();

    target.once('close', () => {
        source[targetBytesWritten] += target.bytesWritten;
        source[targetBytesReceived] += target.bytesReceived;

        source[targets].delete(target);
    });

    if (!source[calculateTargetStats]) {
        source[calculateTargetStats] = () => {
            let bytesWritten = source[targetBytesWritten];
            let bytesReceived = source[targetBytesReceived];

            for (const socket of source[targets]) {
                bytesWritten += socket.bytesWritten;
                bytesReceived += socket.bytesReceived;
            }

            return {
                bytesWritten,
                bytesReceived,
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
        bytesReceived: null,
    };
};

module.exports.countTargetBytes = countTargetBytes;
module.exports.getTargetStats = getTargetStats;
