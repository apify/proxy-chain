import { STATUS_CODES } from 'node:http';

type HttpStatusCode = number;

/**
 * Custom status codes the server responds with instead of the generic `502 Bad Gateway`.
 * See the "Error status codes" section of the README.
 */
export const upstreamErrorStatusCodes = Object.freeze({
    /**
     * Upstream has timed out.
     */
    TIMEOUT: 504,
    /**
     * Upstream responded with non-200 status code.
     */
    NON_200: 590,
    /**
     * Upstream respondend with status code different than 100-999.
     */
    STATUS_CODE_OUT_OF_RANGE: 592,
    /**
     * DNS lookup failed - EAI_NODATA or EAI_NONAME.
     */
    NOT_FOUND: 593,
    /**
     * Upstream refused connection.
     */
    CONNECTION_REFUSED: 594,
    /**
     * Connection reset due to loss of connection or timeout.
     */
    CONNECTION_RESET: 595,
    /**
     * Trying to write on a closed socket.
     */
    BROKEN_PIPE: 596,
    /**
     * Incorrect upstream credentials.
     */
    AUTH_FAILED: 597,
    /**
     * Generic upstream error.
     */
    GENERIC_ERROR: 599,
} as const);

STATUS_CODES['590'] = 'Non Successful';
STATUS_CODES['592'] = 'Status Code Out Of Range';
STATUS_CODES['593'] = 'Not Found';
STATUS_CODES['594'] = 'Connection Refused';
STATUS_CODES['595'] = 'Connection Reset';
STATUS_CODES['596'] = 'Broken Pipe';
STATUS_CODES['597'] = 'Auth Failed';
STATUS_CODES['599'] = 'Upstream Error';

export const createCustomStatusHttpResponse = (statusCode: number, statusMessage: string, message = '') => {
    return [
        `HTTP/1.1 ${statusCode} ${statusMessage || STATUS_CODES[statusCode] || 'Unknown Status Code'}`,
        'Connection: close',
        `Date: ${(new Date()).toUTCString()}`,
        `Content-Length: ${Buffer.byteLength(message)}`,
        ``,
        message,
    ].join('\r\n');
};

// https://nodejs.org/api/errors.html#common-system-errors
export const errorCodeToStatusCode: {[errorCode: string]: HttpStatusCode | undefined} = {
    ENOTFOUND: upstreamErrorStatusCodes.NOT_FOUND,
    ECONNREFUSED: upstreamErrorStatusCodes.CONNECTION_REFUSED,
    ECONNRESET: upstreamErrorStatusCodes.CONNECTION_RESET,
    EPIPE: upstreamErrorStatusCodes.BROKEN_PIPE,
    ETIMEDOUT: upstreamErrorStatusCodes.TIMEOUT,
} as const;

export const socksErrorMessageToStatusCode = (socksErrorMessage: string): typeof upstreamErrorStatusCodes[keyof typeof upstreamErrorStatusCodes] => {
    switch (socksErrorMessage) {
        case 'Proxy connection timed out':
            return upstreamErrorStatusCodes.TIMEOUT;
        case 'Socks5 Authentication failed':
            return upstreamErrorStatusCodes.AUTH_FAILED;
        default:
            return upstreamErrorStatusCodes.GENERIC_ERROR;
    }
};
