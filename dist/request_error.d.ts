/**
 * Represents custom request error. The message is emitted as HTTP response
 * with a specific HTTP code and headers.
 * If this error is thrown from the `prepareRequestFunction` function,
 * the message and status code is sent to client.
 * By default, the response will have Content-Type: text/plain
 * and for the 407 status the Proxy-Authenticate header will be added.
 */
export declare class RequestError extends Error {
    statusCode: number;
    headers?: Record<string, string> | undefined;
    constructor(message: string, statusCode: number, headers?: Record<string, string> | undefined);
}
//# sourceMappingURL=request_error.d.ts.map