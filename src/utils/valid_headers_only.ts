import { validateHeaderName, validateHeaderValue } from 'http';
import { isHopByHopHeader } from './is_hop_by_hop_header';

/**
 * @see https://nodejs.org/api/http.html#http_message_rawheaders
 */
export const validHeadersOnly = (rawHeaders: string[]): Record<string, string[]> => {
    const result: Record<string, string[]> = {};

    let containsHost = false;

    for (let i = 0; i < rawHeaders.length; i += 2) {
        const name = rawHeaders[i];
        const value = rawHeaders[i + 1];

        try {
            validateHeaderName(name);
            validateHeaderValue(name, value);
        } catch (error) {
            // eslint-disable-next-line no-continue
            continue;
        }

        if (isHopByHopHeader(name)) {
            // eslint-disable-next-line no-continue
            continue;
        }

        if (name.toLowerCase() === 'host') {
            if (containsHost) {
                // eslint-disable-next-line no-continue
                continue;
            }

            containsHost = true;
        }

        if (result[name]) {
            result[name].push(value);
        } else {
            result[name] = [value];
        }
    }

    return result;
};
