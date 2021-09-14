const http = require('http');

// As per HTTP specification, hop-by-hop headers should be consumed but the proxy, and not forwarded
const HOP_BY_HOP_HEADERS = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
];

const isHopByHopHeader = (header) => HOP_BY_HOP_HEADERS.includes(header.toLowerCase());

module.exports.isHopByHopHeader = isHopByHopHeader;

const decodeURIComponentSafe = (encodedURIComponent) => {
    try {
        return decodeURIComponent(encodedURIComponent);
    } catch (e) {
        return encodedURIComponent;
    }
};

module.exports.decodeURIComponentSafe = decodeURIComponentSafe;

/**
 * Redacts password from a URL, so that it can be shown in logs, results etc.
 * For example, converts URL such as
 * 'https://username:password@www.example.com/path#hash'
 * to 'https://username:<redacted>@www.example.com/path#hash'
 * @param url URL, it must contain at least protocol and hostname
 * @param passwordReplacement The string that replaces password, by default it is '<redacted>'
 * @returns {string}
 * @ignore
 */
const redactUrl = (url, passwordReplacement = '<redacted>') => {
    if (typeof url !== 'object') {
        url = new URL(url);
    }

    if (url.password) {
        return url.href.replace(`:${url.password}`, `:${passwordReplacement}`)
    }

    return url.href;
};

module.exports.redactUrl = redactUrl;

const PROXY_AUTH_HEADER_REGEX = /^([a-z0-9-]+) ([a-z0-9+/=]+)$/i;

/**
 * Parses the content of the Proxy-Authorization HTTP header.
 * @param header
 * @returns {*} Object with fields { type: String, username: String, password: String }
 * or null if string parsing failed. Note that password and username might be empty strings.
 */
const parseProxyAuthorizationHeader = (header) => {
    const matches = PROXY_AUTH_HEADER_REGEX.exec(header);
    if (!matches) return null;

    const auth = Buffer.from(matches[2], 'base64').toString();
    if (!auth) return null;

    const index = auth.indexOf(':');
    return {
        type: matches[1],
        username: index >= 0 ? auth.substr(0, index) : auth,
        password: index >= 0 ? auth.substr(index + 1) : '',
    };
};

module.exports.parseProxyAuthorizationHeader = parseProxyAuthorizationHeader;

// Replacement for Bluebird's Promise.nodeify()
const nodeify = (promise, callback) => {
    if (typeof callback !== 'function') return promise;

    const p = promise.then((result) => callback(null, result), callback);

    // Handle error from callback function
    p.catch((e) => {
        setTimeout(() => { throw e; }, 0);
    });

    return promise;
};

module.exports.nodeify = nodeify;

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
            http.validateHeaderName(name);
            http.validateHeaderValue(name, value);
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
