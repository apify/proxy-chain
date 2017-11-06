
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