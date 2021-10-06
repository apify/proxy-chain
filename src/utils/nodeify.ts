// Replacement for Bluebird's Promise.nodeify()
export const nodeify = <T>(promise: Promise<T>, callback?: (error: Error | null, result?: T) => void): Promise<T> => {
    if (typeof callback !== 'function') return promise;

    promise.then(
        (result) => callback(null, result),
        callback as any,
    ).catch((error) => {
        // Need to .catch because it doesn't crash the process on Node.js 14
        process.nextTick(() => {
            throw error;
        });
    });

    return promise;
};
