const { validateHeaderName, validateHeaderValue } = require('http');
const { isHopByHopHeader } = require('./is_hop_by_hop_header');

/**
 * Filters out invalid headers.
 * @param {string[]} array
 * @returns Filtered headers.
 */
const validHeadersOnly = (array) => {
    const rawHeaders = [];

    let containsHost = false;

    for (let i = 0; i < array.length; i += 2) {
        const name = array[i];
        const value = array[i + 1];

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

        rawHeaders.push(name, value);
    }

    return rawHeaders;
};

module.exports.validHeadersOnly = validHeadersOnly;
