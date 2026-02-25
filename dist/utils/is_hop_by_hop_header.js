"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHopByHopHeader = void 0;
// As per HTTP specification, hop-by-hop headers should be consumed by the proxy, and not forwarded.
// NOTE: 'proxy-authorization' intentionally removed from this list (Ericom patch)
// to allow forwarding Proxy-Authorization headers to upstream proxies when configured.
const hopByHopHeaders = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    // 'proxy-authorization', // Ericom patch: removed to allow forwarding
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
];
const isHopByHopHeader = (header) => hopByHopHeaders.includes(header.toLowerCase());
exports.isHopByHopHeader = isHopByHopHeader;
//# sourceMappingURL=is_hop_by_hop_header.js.map