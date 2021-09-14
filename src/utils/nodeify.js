// Replacement for Bluebird's Promise.nodeify()
const nodeify = (promise, callback) => {
    if (typeof callback !== 'function') return promise;

    promise.then((result) => callback(null, result), callback);

    return promise;
};

module.exports.nodeify = nodeify;
