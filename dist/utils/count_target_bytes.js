"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTargetStats = exports.countTargetBytes = void 0;
const targetBytesWritten = Symbol('targetBytesWritten');
const targetBytesRead = Symbol('targetBytesRead');
const targets = Symbol('targets');
const calculateTargetStats = Symbol('calculateTargetStats');
// @ts-expect-error TS is not aware that `source` is used in the assertion.
// eslint-disable-next-line @typescript-eslint/no-empty-function
function typeSocket(source) { }
const countTargetBytes = (source, target, registerCloseHandler) => {
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
        registerCloseHandler = (handler) => target.once('close', handler);
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
exports.countTargetBytes = countTargetBytes;
const getTargetStats = (socket) => {
    typeSocket(socket);
    if (socket[calculateTargetStats]) {
        return socket[calculateTargetStats]();
    }
    return {
        bytesWritten: null,
        bytesRead: null,
    };
};
exports.getTargetStats = getTargetStats;
//# sourceMappingURL=count_target_bytes.js.map