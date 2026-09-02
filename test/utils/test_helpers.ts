import type net from 'node:net';

/**
 * `server.address()` is typed as `AddressInfo | string | null`, so every caller that
 * just wants the bound TCP port needs this narrowing.
 */
export const getServerPort = (server: net.Server): number => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Server is not listening on a TCP port.');
    }
    return address.port;
};

/**
 * Promisified `server.listen()` resolving to the bound port. Written as a plain
 * Promise because `util.promisify(server.listen)` loses its overloads under TypeScript.
 */
export const listenOnPort = async (server: net.Server, port = 0): Promise<number> => {
    return await new Promise((resolve, reject) => {
        const onListening = () => {
            // eslint-disable-next-line no-use-before-define -- onListening and onError deregister each other.
            server.off('error', onError);
            resolve(getServerPort(server));
        };
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
    });
};

/** Ignores the close error, matching the `new Promise((resolve) => server.close(resolve))` teardowns it replaces. */
export const closeServer = async (server: net.Server): Promise<void> => {
    return await new Promise((resolve) => {
        server.close(() => resolve());
    });
};

/** `Array#shift()` is `number | undefined`; a missing port is a broken test, not a case to handle. */
export const takePort = (freePorts: number[]): number => {
    const port = freePorts.shift();
    if (port === undefined) throw new Error('Ran out of free ports.');
    return port;
};

export const wait = async (timeoutMillis: number): Promise<void> => {
    return await new Promise((resolve) => {
        setTimeout(resolve, timeoutMillis);
    });
};
