import urlModule from 'url';
import through from 'through';

const HOST_HEADER_REGEX = /^((([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9]))(:([0-9]+))?$/;

const HOP_BY_HOP_HEADERS = [
    'Connection',
    'Keep-Alive',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'TE',
    'Trailers',
    'Transfer-Encoding',
    'Upgrade'
];

const HOP_BY_HOP_HEADERS_REGEX = new RegExp('^(' + HOP_BY_HOP_HEADERS.join('|') + ')$', 'i');


// TODO: add unit test
export const parseHostHeader = (hostHeader) => {
    const matches = HOST_HEADER_REGEX.exec(hostHeader);
    if (!matches) return null;

    let host = matches[1];
    let port = parseInt(matches[6] || '80');

    if (host.length > 255) return null;
    if (!(port > 0 && port <= 65535)) return null;

    return { host, port };
};

export const isHopByHopHeader = (header) => HOP_BY_HOP_HEADERS_REGEX.test(header);




/**
 * Sames are Node's url.parse() just adds the 'username', 'password' and 'scheme' fields.
 * TODO: this code is copied from apify package, reuse the same one !!!
 * @param url
 * @ignore
 */
export const parseUrl = (url) => {
    const parsed = urlModule.parse(url);

    parsed.username = null;
    parsed.password = null;
    parsed.scheme = null;

    if (parsed.auth) {
        const matches = /^([^:]+)(:?)(.*)$/.exec(parsed.auth);
        if (matches && matches.length === 4) {
            parsed.username = matches[1];
            if (matches[2] === ':') parsed.password = matches[3];
        }
    }

    if (parsed.protocol) {
        const matches = /^([a-z0-9]+):$/i.exec(parsed.protocol);
        if (matches && matches.length === 2) {
            parsed.scheme = matches[1];
        }
    }

    return parsed;
};


/**
 * Works like Bash tee, but instead of passing output to file,
 * passes output to log
 *
 * @param   {String}   name          identifier
 * @param   {Boolean}  initialOnly   log only initial chunk of data
 * @return  {through}                duplex stream (pipe)
 */
export const tee = (name, initialOnly = true) => {
    console.log('tee');
    let maxChunks = 2;
    let duplex = through( chunk => {
        if (maxChunks || !initialOnly) {
            let msg = chunk.toString();
            msg += '';
            maxChunks--;
            console.log('pipe: ' + JSON.stringify({
                context: name,
                chunkHead: chunk.toString().slice(0, 100)
            }));
        }
        duplex.queue(chunk);
    });

    return duplex;
};