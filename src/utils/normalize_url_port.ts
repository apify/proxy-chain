import type { URL } from 'url';

// https://url.spec.whatwg.org/#default-port
const mapping = {
    'ftp:': 21,
    'http:': 80,
    'https:': 443,
    'ws:': 80,
    'wss:': 443,
};

export const normalizeUrlPort = (url: URL): number => {
    if (url.port) {
        return Number(url.port);
    }

    if (mapping.hasOwnProperty(url.protocol)) {
        return mapping[url.protocol as keyof typeof mapping];
    }

    throw new Error(`Unexpected protocol: ${url.protocol}`);
};
