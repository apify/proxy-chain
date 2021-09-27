// As per HTTP specification, hop-by-hop headers should be consumed but the proxy, and not forwarded
const hopByHopHeaders = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
];

export const isHopByHopHeader = (header: string): boolean => hopByHopHeaders.includes(header.toLowerCase());
