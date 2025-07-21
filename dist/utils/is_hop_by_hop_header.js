"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHopByHopHeader = void 0;
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
const isHopByHopHeader = (header) => hopByHopHeaders.includes(header.toLowerCase());
exports.isHopByHopHeader = isHopByHopHeader;
//# sourceMappingURL=is_hop_by_hop_header.js.map