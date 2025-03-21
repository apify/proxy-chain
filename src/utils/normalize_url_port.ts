import type { URL } from 'node:url';

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

    if (url.protocol in mapping) {
        return mapping[url.protocol as keyof typeof mapping];
    }

    throw new Error(`Unexpected protocol: ${url.protocol}`);
};
