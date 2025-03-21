import { validateHeaderName, validateHeaderValue } from 'node:http';

import { isHopByHopHeader } from './is_hop_by_hop_header';

/**
 * @see https://nodejs.org/api/http.html#http_message_rawheaders
 */
export const validHeadersOnly = (rawHeaders: string[]): string[] => {
    const result = [];

    let containsHost = false;

    for (let i = 0; i < rawHeaders.length; i += 2) {
        const name = rawHeaders[i];
        const value = rawHeaders[i + 1];

        try {
            validateHeaderName(name);
            validateHeaderValue(name, value);
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

        result.push(name, value);
    }

    return result;
};
