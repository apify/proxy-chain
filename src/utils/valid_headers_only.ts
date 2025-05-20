import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { validateHeaderName, validateHeaderValue } from 'node:http';

import { isHopByHopHeader } from './is_hop_by_hop_header';

/**
 * @see https://nodejs.org/api/http.html#http_message_rawheaders
 */
export const validHeadersOnly = (rawHeaders: IncomingHttpHeaders): OutgoingHttpHeaders => {
    const result: OutgoingHttpHeaders = {};

    let containsHost = false;

    for (const [name, value] of Object.entries(rawHeaders)) {
        try {
            validateHeaderName(name);

            if (Array.isArray(value)) {
                for (const v of value) {
                    validateHeaderValue(name, v);
                }
            } else if (value !== undefined) {
                validateHeaderValue(name, value);
            }
        } catch {
            continue;
        }

        if (isHopByHopHeader(name)) {
            continue;
        }

        if (name.toLowerCase() === 'host') {
            if (containsHost) {
                continue;
            }

            containsHost = true;
        }

        result[name] = value;
    }

    return result;
};
