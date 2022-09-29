import { STATUS_CODES } from 'http';

type HttpStatusCode = number;

export const badGatewayStatusCodes = {
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
} as const;

STATUS_CODES['590'] = 'Non Successful';
STATUS_CODES['592'] = 'Status Code Out Of Range';
STATUS_CODES['593'] = 'Not Found';
STATUS_CODES['594'] = 'Connection Refused';
STATUS_CODES['595'] = 'Connection Reset';
STATUS_CODES['596'] = 'Broken Pipe';
STATUS_CODES['597'] = 'Auth Failed';
STATUS_CODES['599'] = 'Upstream Error';

// https://nodejs.org/api/errors.html#common-system-errors
export const errorCodeToStatusCode: {[errorCode: string]: HttpStatusCode | undefined} = {
    ENOTFOUND: badGatewayStatusCodes.NOT_FOUND,
    ECONNREFUSED: badGatewayStatusCodes.CONNECTION_REFUSED,
    ECONNRESET: badGatewayStatusCodes.CONNECTION_RESET,
    EPIPE: badGatewayStatusCodes.BROKEN_PIPE,
    ETIMEDOUT: badGatewayStatusCodes.TIMEOUT,
} as const;
