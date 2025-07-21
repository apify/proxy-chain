"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestError = void 0;
/**
 * Represents custom request error. The message is emitted as HTTP response
 * with a specific HTTP code and headers.
 * If this error is thrown from the `prepareRequestFunction` function,
 * the message and status code is sent to client.
 * By default, the response will have Content-Type: text/plain
 * and for the 407 status the Proxy-Authenticate header will be added.
 */
class RequestError extends Error {
    constructor(message, statusCode, headers) {
        super(message);
        Object.defineProperty(this, "statusCode", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: statusCode
        });
        Object.defineProperty(this, "headers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: headers
        });
        this.name = RequestError.name;
        Error.captureStackTrace(this, RequestError);
    }
}
exports.RequestError = RequestError;
//# sourceMappingURL=request_error.js.map