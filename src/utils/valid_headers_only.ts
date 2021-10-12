<<<<<<< HEAD
import { validateHeaderName, validateHeaderValue } from 'node:http';

=======
// @ts-expect-error Missing types
import { validateHeaderName, validateHeaderValue } from 'http';
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
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
<<<<<<< HEAD
        } catch {
=======
        } catch (error) {
            // eslint-disable-next-line no-continue
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
            continue;
        }

        if (isHopByHopHeader(name)) {
<<<<<<< HEAD
=======
            // eslint-disable-next-line no-continue
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
            continue;
        }

        if (name.toLowerCase() === 'host') {
            if (containsHost) {
<<<<<<< HEAD
=======
                // eslint-disable-next-line no-continue
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
                continue;
            }

            containsHost = true;
        }

        result.push(name, value);
    }

    return result;
};
