import { _checkIsHttpToken, _checkInvalidHeaderChar } from '_http_common'; // eslint-disable-line

const HOST_HEADER_REGEX = /^((([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]))(:([0-9]+))?$/;

/**
 * Parsed the 'Host' HTTP header and returns an object with { host: String, port: Number }.
 * For example, for 'www.example.com:80' it returns { host: 'www.example.com', port: 80 }.
 * If port is not present, the function
 * If the header is invalid, returns null.
 * @param hostHeader
 * @return {*}
 */
export const parseHostHeader = (hostHeader) => {
    const matches = HOST_HEADER_REGEX.exec(hostHeader || '');
    if (!matches) return null;

    const hostname = matches[1];
    if (hostname.length > 255) return null;

    let port = null;
    if (matches[5]) {
        port = parseInt(matches[6], 10);
        if (!(port > 0 && port <= 65535)) return null;
    }

    return { hostname, port };
};

// As per HTTP specification, hop-by-hop headers should be consumed but the proxy, and not forwarded
const HOP_BY_HOP_HEADERS = [
    'Connection',
    'Keep-Alive',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
];

const HOP_BY_HOP_HEADERS_REGEX = new RegExp(`^(${HOP_BY_HOP_HEADERS.join('|')})$`, 'i');

export const isHopByHopHeader = (header) => HOP_BY_HOP_HEADERS_REGEX.test(header);

// This code is based on Node.js' validateHeader() function from _http_outgoing.js module
// (see https://github.com/nodejs/node/blob/189d29f39e6de9ccf10682bfd1341819b4a2291f/lib/_http_outgoing.js#L485)
export const isInvalidHeader = (name, value) => {
    // NOTE: These are internal Node.js functions, they might stop working in the future!
    return typeof name !== 'string'
        || !name
        || !_checkIsHttpToken(name)
        || value === undefined
        || _checkInvalidHeaderChar(value);
};

/**
 * Wraps `new URL(url)` and adds following:
 *  - `port` is casted to number / null from string
 *  - `path` field is added (pathname + search)
 *  - malformed or relative urls are parsed as well (always, the given string is returned as is in
 *    few fields, other are left undefined)
 *
 * Using `new URL` causes following:
 *  - we are unable to distiguish empty password and missing password
 *  - password and username are empty string if not present (or empty)
 *  - we are able to parse IPv6
 *  - there might be issues with password being urlencoded
 *
 * @param url
 * @ignore
 */
export const parseUrl = (url) => {
    // NOTE: Not using url.parse() because it can't handle IPv6 and other special URLs
    try {
        const urlObj = new URL(url);

        const parsed = {
            hash: urlObj.hash,
            host: urlObj.host,
            hostname: urlObj.hostname,
            href: urlObj.href,
            origin: urlObj.origin,
            password: urlObj.password,
            username: urlObj.username,
            pathname: urlObj.pathname,
            // Path was present on the original UrlObject, it's kept for backwards compatibility
            path: `${urlObj.pathname}${urlObj.search}`,
            // Port is turned into a number if available
            port: urlObj.port ? parseInt(urlObj.port, 10) : null,
            protocol: urlObj.protocol,
            scheme: null,
            search: urlObj.search,
            searchParams: urlObj.searchParams,
        };

        // Add scheme field (as some other external tools rely on that)
        if (parsed.protocol) {
            const matches = /^([a-z0-9]+):$/i.exec(parsed.protocol);
            if (matches && matches.length === 2) {
                parsed.scheme = matches[1];
            }
        }

        return parsed;
    } catch (e) {
        // Malformed (or relative) urls need to be treated as well.
        return {
            pathname: url,
            path: url,
            href: url,
        };
    }
};

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
export const redactUrl = (url, passwordReplacement) => {
    return redactParsedUrl(parseUrl(url), passwordReplacement);
};

export const redactParsedUrl = (parsedUrl, passwordReplacement = '<redacted>') => {
    const p = parsedUrl;
    let auth = null;
    if (p.username) {
        if (p.password) {
            auth = `${p.username}:${passwordReplacement}`;
        } else {
            auth = `${p.username}`;
        }
    }
    return `${p.protocol}//${auth || ''}${auth ? '@' : ''}${p.host}${p.path || ''}${p.hash || ''}`;
};

const PROXY_AUTH_HEADER_REGEX = /^([a-z0-9-]+) ([a-z0-9+/=]+)$/i;

/**
 * Parses the content of the Proxy-Authorization HTTP header.
 * @param header
 * @returns {*} Object with fields { type: String, username: String, password: String }
 * or null if string parsing failed. Note that password and username might be empty strings.
 */
export const parseProxyAuthorizationHeader = (header) => {
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

export const addHeader = (headers, name, value) => {
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

export const PORT_SELECTION_CONFIG = {
    FROM: 20000,
    TO: 60000,
    RETRY_COUNT: 10,
};

export const maybeAddProxyAuthorizationHeader = (parsedUrl, headers) => {
    if (parsedUrl && parsedUrl.username) {
        let auth = parsedUrl.username;
        if (parsedUrl.password || parsedUrl.password === '') auth += `:${parsedUrl.password}`;
        headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
    }
};

// Replacement for Bluebird's Promise.nodeify()
export const nodeify = (promise, callback) => {
    if (typeof callback !== 'function') return promise;

    const p = promise.then((result) => callback(null, result), callback);

    // Handle error from callback function
    p.catch((e) => {
        setTimeout(() => { throw e; }, 0);
    });

    return promise;
};
