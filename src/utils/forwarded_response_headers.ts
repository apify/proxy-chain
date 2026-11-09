import type http from 'node:http';

import { validHeadersOnly } from './valid_headers_only.js';

// Transfer-Encoding is hop-by-hop and gets stripped, so a Content-Length sent alongside it no longer describes
// the body. RFC 9112 section 6.3 requires an intermediary to remove it; Node then re-frames the body as chunked.
export const forwardedResponseHeaders = (clientResponse: http.IncomingMessage): string[] => {
    const headers = validHeadersOnly(clientResponse.rawHeaders);

    if (clientResponse.headers['transfer-encoding'] === undefined) {
        return headers;
    }

    const withoutContentLength = [];

    // `headers` is a flat [name, value, name, value, ...] array, so step by 2 and drop the content-length pair.
    for (let index = 0; index < headers.length; index += 2) {
        if (headers[index].toLowerCase() !== 'content-length') {
            withoutContentLength.push(headers[index], headers[index + 1]);
        }
    }

    return withoutContentLength;
};
