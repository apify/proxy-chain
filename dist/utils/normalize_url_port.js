"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeUrlPort = void 0;
// https://url.spec.whatwg.org/#default-port
const mapping = {
    'ftp:': 21,
    'http:': 80,
    'https:': 443,
    'ws:': 80,
    'wss:': 443,
};
const normalizeUrlPort = (url) => {
    if (url.port) {
        return Number(url.port);
    }
    if (url.protocol in mapping) {
        return mapping[url.protocol];
    }
    throw new Error(`Unexpected protocol: ${url.protocol}`);
};
exports.normalizeUrlPort = normalizeUrlPort;
//# sourceMappingURL=normalize_url_port.js.map