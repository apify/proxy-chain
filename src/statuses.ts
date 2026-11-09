import { STATUS_CODES } from 'node:http';

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
});

export type UpstreamErrorStatusCode = (typeof upstreamErrorStatusCodes)[keyof typeof upstreamErrorStatusCodes];

STATUS_CODES[upstreamErrorStatusCodes.NON_200] = 'Non Successful';
STATUS_CODES[upstreamErrorStatusCodes.STATUS_CODE_OUT_OF_RANGE] = 'Status Code Out Of Range';
STATUS_CODES[upstreamErrorStatusCodes.NOT_FOUND] = 'Not Found';
STATUS_CODES[upstreamErrorStatusCodes.CONNECTION_REFUSED] = 'Connection Refused';
STATUS_CODES[upstreamErrorStatusCodes.CONNECTION_RESET] = 'Connection Reset';
STATUS_CODES[upstreamErrorStatusCodes.BROKEN_PIPE] = 'Broken Pipe';
STATUS_CODES[upstreamErrorStatusCodes.AUTH_FAILED] = 'Auth Failed';
STATUS_CODES[upstreamErrorStatusCodes.GENERIC_ERROR] = 'Upstream Error';

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
export const errorCodeToStatusCode: Partial<Record<string, UpstreamErrorStatusCode>> = {
    ENOTFOUND: upstreamErrorStatusCodes.NOT_FOUND,
    ECONNREFUSED: upstreamErrorStatusCodes.CONNECTION_REFUSED,
    ECONNRESET: upstreamErrorStatusCodes.CONNECTION_RESET,
    EPIPE: upstreamErrorStatusCodes.BROKEN_PIPE,
    ETIMEDOUT: upstreamErrorStatusCodes.TIMEOUT,
};

export const socksErrorMessageToStatusCode = (socksErrorMessage: string): UpstreamErrorStatusCode => {
    switch (socksErrorMessage) {
        case 'Proxy connection timed out':
            return upstreamErrorStatusCodes.TIMEOUT;
        case 'Socks5 Authentication failed':
            return upstreamErrorStatusCodes.AUTH_FAILED;
        default:
            return upstreamErrorStatusCodes.GENERIC_ERROR;
    }
};
