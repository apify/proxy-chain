"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socksErrorMessageToStatusCode = exports.errorCodeToStatusCode = exports.createCustomStatusHttpResponse = exports.badGatewayStatusCodes = void 0;
const node_http_1 = require("node:http");
exports.badGatewayStatusCodes = {
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
};
node_http_1.STATUS_CODES['590'] = 'Non Successful';
node_http_1.STATUS_CODES['592'] = 'Status Code Out Of Range';
node_http_1.STATUS_CODES['593'] = 'Not Found';
node_http_1.STATUS_CODES['594'] = 'Connection Refused';
node_http_1.STATUS_CODES['595'] = 'Connection Reset';
node_http_1.STATUS_CODES['596'] = 'Broken Pipe';
node_http_1.STATUS_CODES['597'] = 'Auth Failed';
node_http_1.STATUS_CODES['599'] = 'Upstream Error';
const createCustomStatusHttpResponse = (statusCode, statusMessage, message = '') => {
    return [
        `HTTP/1.1 ${statusCode} ${statusMessage || node_http_1.STATUS_CODES[statusCode] || 'Unknown Status Code'}`,
        'Connection: close',
        `Date: ${(new Date()).toUTCString()}`,
        `Content-Length: ${Buffer.byteLength(message)}`,
        ``,
        message,
    ].join('\r\n');
};
exports.createCustomStatusHttpResponse = createCustomStatusHttpResponse;
// https://nodejs.org/api/errors.html#common-system-errors
exports.errorCodeToStatusCode = {
    ENOTFOUND: exports.badGatewayStatusCodes.NOT_FOUND,
    ECONNREFUSED: exports.badGatewayStatusCodes.CONNECTION_REFUSED,
    ECONNRESET: exports.badGatewayStatusCodes.CONNECTION_RESET,
    EPIPE: exports.badGatewayStatusCodes.BROKEN_PIPE,
    ETIMEDOUT: exports.badGatewayStatusCodes.TIMEOUT,
};
const socksErrorMessageToStatusCode = (socksErrorMessage) => {
    switch (socksErrorMessage) {
        case 'Proxy connection timed out':
            return exports.badGatewayStatusCodes.TIMEOUT;
        case 'Socks5 Authentication failed':
            return exports.badGatewayStatusCodes.AUTH_FAILED;
        default:
            return exports.badGatewayStatusCodes.GENERIC_ERROR;
    }
};
exports.socksErrorMessageToStatusCode = socksErrorMessageToStatusCode;
//# sourceMappingURL=statuses.js.map