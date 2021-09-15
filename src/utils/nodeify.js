// Replacement for Bluebird's Promise.nodeify()
const nodeify = (promise, callback) => {
    if (typeof callback !== 'function') return promise;

    promise.then(
        (result) => callback(null, result),
        callback,
        // Need to .catch because it doesn't crash the process on Node.js 14
    ).catch((error) => {
        process.nextTick(() => {
            throw error;
        });
    });

    return promise;
};

module.exports.nodeify = nodeify;
