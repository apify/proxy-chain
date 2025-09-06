"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBasicAuthorizationHeader = void 0;
const decode_uri_component_safe_1 = require("./decode_uri_component_safe");
const getBasicAuthorizationHeader = (url) => {
    const username = (0, decode_uri_component_safe_1.decodeURIComponentSafe)(url.username);
    const password = (0, decode_uri_component_safe_1.decodeURIComponentSafe)(url.password);
    const auth = `${username}:${password}`;
    if (username.includes(':')) {
        throw new Error('Username contains an invalid colon');
    }
    return `Basic ${Buffer.from(auth).toString('base64')}`;
};
exports.getBasicAuthorizationHeader = getBasicAuthorizationHeader;
//# sourceMappingURL=get_basic.js.map