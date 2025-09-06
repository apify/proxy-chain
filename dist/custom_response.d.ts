/// <reference types="node" />
/// <reference types="node" />
import type { Buffer } from 'node:buffer';
import type http from 'node:http';
export interface CustomResponse {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
    encoding?: BufferEncoding;
}
export interface HandlerOpts {
    customResponseFunction: () => CustomResponse | Promise<CustomResponse>;
}
export declare const handleCustomResponse: (_request: http.IncomingMessage, response: http.ServerResponse, handlerOpts: HandlerOpts) => Promise<void>;
//# sourceMappingURL=custom_response.d.ts.map