"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validHeadersOnly = void 0;
const node_http_1 = require("node:http");
const is_hop_by_hop_header_1 = require("./is_hop_by_hop_header");
/**
 * @see https://nodejs.org/api/http.html#http_message_rawheaders
 */
const validHeadersOnly = (rawHeaders) => {
    const result = [];
    let containsHost = false;
    for (let i = 0; i < rawHeaders.length; i += 2) {
        const name = rawHeaders[i];
        const value = rawHeaders[i + 1];
        try {
            (0, node_http_1.validateHeaderName)(name);
            (0, node_http_1.validateHeaderValue)(name, value);
        }
        catch {
            continue;
        }
        if ((0, is_hop_by_hop_header_1.isHopByHopHeader)(name)) {
            continue;
        }
        if (name.toLowerCase() === 'host') {
            if (containsHost) {
                continue;
            }
            containsHost = true;
        }
        result.push(name, value);
    }
    return result;
};
exports.validHeadersOnly = validHeadersOnly;
//# sourceMappingURL=valid_headers_only.js.map