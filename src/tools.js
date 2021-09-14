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

const TOKEN_REGEX = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;

/**
 * Verifies that the given val is a valid HTTP token per the rules defined in RFC 7230
 * @see https://tools.ietf.org/html/rfc7230#section-3.2.6
 * @see https://github.com/nodejs/node/blob/8cf5ae07e9e80747c19e0fc04fad48423707f62c/lib/_http_common.js#L222
 */
const isHttpToken = (val) => TOKEN_REGEX.test(val);

const HEADER_CHAR_REGEX = /[^\t\x20-\x7e\x80-\xff]/;

/**
 * True if val contains an invalid field-vchar
 *  field-value    = *( field-content / obs-fold )
 *  field-content  = field-vchar [ 1*( SP / HTAB ) field-vchar ]
 *  field-vchar    = VCHAR / obs-text
 * @see https://github.com/nodejs/node/blob/8cf5ae07e9e80747c19e0fc04fad48423707f62c/lib/_http_common.js#L233
 */
const isInvalidHeaderChar = (val) => HEADER_CHAR_REGEX.test(val);

// This code is based on Node.js' validateHeader() function from _http_outgoing.js module
// (see https://github.com/nodejs/node/blob/189d29f39e6de9ccf10682bfd1341819b4a2291f/lib/_http_outgoing.js#L485)
const isInvalidHeader = (name, value) => {
    // NOTE: These are internal Node.js functions, they might stop working in the future!
    return typeof name !== 'string'
        || !name
        || !isHttpToken(name)
        || value === undefined
        || isInvalidHeaderChar(value);
};

module.exports.isInvalidHeader = isInvalidHeader;

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

/**
 * Works like Bash tee, but instead of passing output to file,
 * passes output to log
 *
 * @param   {String}   name          identifier
 * @param   {Boolean}  initialOnly   log only initial chunk of data
 * @return  {through}                duplex stream (pipe)

export const tee = (name, initialOnly = true) => {
    console.log('tee');
    let maxChunks = 2;
    const duplex = through((chunk) => {
        if (maxChunks || !initialOnly) {
            // let msg = chunk.toString();
            // msg += '';
            maxChunks--;
            console.log(`pipe: ${JSON.stringify({
                context: name,
                chunkHead: chunk.toString().slice(0, 100),
            })}`);
        }
        duplex.queue(chunk);
    });

    return duplex;
};
*/

const addHeader = (headers, name, value) => {
    if (headers[name] === undefined) {
        headers[name] = value;
    } else if (Array.isArray(headers[name])) {
        headers[name].push(value);
    } else {
        headers[name] = [
            headers[name],
            value,
        ];
    }
};

module.exports.addHeader = addHeader;

const PORT_SELECTION_CONFIG = {
    FROM: 20000,
    TO: 60000,
    RETRY_COUNT: 10,
};

module.exports.PORT_SELECTION_CONFIG = PORT_SELECTION_CONFIG;

const maybeAddProxyAuthorizationHeader = (parsedUrl, headers) => {
    if (parsedUrl && (parsedUrl.username || parsedUrl.password)) {
        const username = decodeURIComponentSafe(parsedUrl.username);
        const password = decodeURIComponentSafe(parsedUrl.password);

        // According to RFC 7617 (see https://tools.ietf.org/html/rfc7617#page-5):
        //  "Furthermore, a user-id containing a colon character is invalid, as
        //   the first colon in a user-pass string separates user-id and password
        //   from one another; text after the first colon is part of the password.
        //   User-ids containing colons cannot be encoded in user-pass strings."
        // So to be correct and avoid strange errors later, we just throw an error
        if (/:/.test(username)) throw new Error('The proxy username cannot contain the colon (:) character according to RFC 7617.');
        const auth = `${username || ''}:${password || ''}`;
        headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
    }
};

module.exports.maybeAddProxyAuthorizationHeader = maybeAddProxyAuthorizationHeader;

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
