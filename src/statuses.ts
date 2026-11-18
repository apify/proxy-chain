import { STATUS_CODES } from 'node:http';

type ValueOf<T> = T[keyof T];

/**
 * Custom status codes the server responds with instead of the generic `502 Bad Gateway`.
 * See the "Error status codes" section of the README.
 */
export const UPSTREAM_ERROR_STATUS_CODE = Object.freeze({
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

export type UpstreamErrorStatusCode = ValueOf<typeof UPSTREAM_ERROR_STATUS_CODE>;

// Not exported: a target can return its own 504, so clients cannot tell the two apart.
const UPSTREAM_TIMEOUT_STATUS_CODE = 504;

type InternalUpstreamErrorStatusCode = UpstreamErrorStatusCode | typeof UPSTREAM_TIMEOUT_STATUS_CODE;

STATUS_CODES[UPSTREAM_ERROR_STATUS_CODE.NON_200] = 'Non Successful';
STATUS_CODES[UPSTREAM_ERROR_STATUS_CODE.STATUS_CODE_OUT_OF_RANGE] = 'Status Code Out Of Range';
STATUS_CODES[UPSTREAM_ERROR_STATUS_CODE.NOT_FOUND] = 'Not Found';
STATUS_CODES[UPSTREAM_ERROR_STATUS_CODE.CONNECTION_REFUSED] = 'Connection Refused';
STATUS_CODES[UPSTREAM_ERROR_STATUS_CODE.CONNECTION_RESET] = 'Connection Reset';
STATUS_CODES[UPSTREAM_ERROR_STATUS_CODE.BROKEN_PIPE] = 'Broken Pipe';
STATUS_CODES[UPSTREAM_ERROR_STATUS_CODE.AUTH_FAILED] = 'Auth Failed';
STATUS_CODES[UPSTREAM_ERROR_STATUS_CODE.GENERIC_ERROR] = 'Upstream Error';

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
export const errorCodeToStatusCode: Partial<Record<string, InternalUpstreamErrorStatusCode>> = {
    ENOTFOUND: UPSTREAM_ERROR_STATUS_CODE.NOT_FOUND,
    ECONNREFUSED: UPSTREAM_ERROR_STATUS_CODE.CONNECTION_REFUSED,
    ECONNRESET: UPSTREAM_ERROR_STATUS_CODE.CONNECTION_RESET,
    EPIPE: UPSTREAM_ERROR_STATUS_CODE.BROKEN_PIPE,
    ETIMEDOUT: UPSTREAM_TIMEOUT_STATUS_CODE,
};

export const socksErrorMessageToStatusCode = (socksErrorMessage: string): InternalUpstreamErrorStatusCode => {
    switch (socksErrorMessage) {
        case 'Proxy connection timed out':
            return UPSTREAM_TIMEOUT_STATUS_CODE;
        case 'Socks5 Authentication failed':
            return UPSTREAM_ERROR_STATUS_CODE.AUTH_FAILED;
        default:
            return UPSTREAM_ERROR_STATUS_CODE.GENERIC_ERROR;
    }
};
