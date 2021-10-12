// Replacement for Bluebird's Promise.nodeify()
<<<<<<< HEAD
export const nodeify = async <T>(promise: Promise<T>, callback?: (error: Error | null, result?: T) => void): Promise<T> => {
=======
export const nodeify = <T>(promise: Promise<T>, callback?: (error: Error | null, result?: T) => void): Promise<T> => {
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
    if (typeof callback !== 'function') return promise;

    promise.then(
        (result) => callback(null, result),
<<<<<<< HEAD
        callback,
=======
        callback as any,
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
    ).catch((error) => {
        // Need to .catch because it doesn't crash the process on Node.js 14
        process.nextTick(() => {
            throw error;
        });
    });

    return promise;
};
