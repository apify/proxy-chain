import type http from 'node:http';

import { validHeadersOnly } from './valid_headers_only.js';

// The upstream response is parsed leniently (`insecureHTTPParser`), so llhttp accepts Content-Length together with
// Transfer-Encoding and frames the body by the chunked encoding. Transfer-Encoding is hop-by-hop and gets stripped,
// so forwarding the upstream Content-Length would hand the client a length that does not match the body and let a
// malicious upstream desync the client's connection. RFC 9112 section 6.3 requires an intermediary forwarding such
// a message to remove Content-Length first. Without either header Node re-frames the body as chunked.
export const forwardedResponseHeaders = (clientResponse: http.IncomingMessage): string[] => {
    const headers = validHeadersOnly(clientResponse.rawHeaders);

    if (clientResponse.headers['transfer-encoding'] === undefined) {
        return headers;
    }

    const withoutContentLength = [];

    for (let index = 0; index < headers.length; index += 2) {
        if (headers[index].toLowerCase() !== 'content-length') {
            withoutContentLength.push(headers[index], headers[index + 1]);
        }
    }

    return withoutContentLength;
};
