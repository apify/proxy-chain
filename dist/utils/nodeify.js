"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nodeify = void 0;
// Replacement for Bluebird's Promise.nodeify()
const nodeify = async (promise, callback) => {
    if (typeof callback !== 'function')
        return promise;
    promise.then((result) => callback(null, result), callback).catch((error) => {
        // Need to .catch because it doesn't crash the process on Node.js 14
        process.nextTick(() => {
            throw error;
        });
    });
    return promise;
};
exports.nodeify = nodeify;
//# sourceMappingURL=nodeify.js.map