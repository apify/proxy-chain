/** Throws if `port` is not a valid TCP port number (0-65535). */
export const validateListenPort = (port: number): void => {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`The "port" option must be an integer between 0 and 65535 (was ${port})`);
    }
};
