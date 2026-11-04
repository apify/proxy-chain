import type http from 'node:http';

import { validHeadersOnly } from './valid_headers_only.js';

// Node de-chunks the inbound body but only re-chunks outbound bodies on methods that have one by default.
// On GET, HEAD, DELETE and OPTIONS the body would otherwise be written raw and parsed upstream as a new request.
export const forwardedRequestHeaders = (request: http.IncomingMessage): string[] => {
    const headers = validHeadersOnly(request.rawHeaders);

    if (request.headers['transfer-encoding'] === undefined) {
        return headers;
    }

    const withoutContentLength = [];

    for (let index = 0; index < headers.length; index += 2) {
        if (headers[index].toLowerCase() !== 'content-length') {
            withoutContentLength.push(headers[index], headers[index + 1]);
        }
    }

    return [...withoutContentLength, 'transfer-encoding', 'chunked'];
};
