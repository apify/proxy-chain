type HttpStatusCode = number;
export declare const badGatewayStatusCodes: {
    /**
     * Upstream has timed out.
     */
    readonly TIMEOUT: 504;
    /**
     * Upstream responded with non-200 status code.
     */
    readonly NON_200: 590;
    /**
     * Upstream respondend with status code different than 100-999.
     */
    readonly STATUS_CODE_OUT_OF_RANGE: 592;
    /**
     * DNS lookup failed - EAI_NODATA or EAI_NONAME.
     */
    readonly NOT_FOUND: 593;
    /**
     * Upstream refused connection.
     */
    readonly CONNECTION_REFUSED: 594;
    /**
     * Connection reset due to loss of connection or timeout.
     */
    readonly CONNECTION_RESET: 595;
    /**
     * Trying to write on a closed socket.
     */
    readonly BROKEN_PIPE: 596;
    /**
     * Incorrect upstream credentials.
     */
    readonly AUTH_FAILED: 597;
    /**
     * Generic upstream error.
     */
    readonly GENERIC_ERROR: 599;
};
export declare const createCustomStatusHttpResponse: (statusCode: number, statusMessage: string, message?: string) => string;
export declare const errorCodeToStatusCode: {
    [errorCode: string]: HttpStatusCode | undefined;
};
export declare const socksErrorMessageToStatusCode: (socksErrorMessage: string) => (typeof badGatewayStatusCodes)[keyof typeof badGatewayStatusCodes];
export {};
//# sourceMappingURL=statuses.d.ts.map