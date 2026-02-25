"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAuthorizationHeader = void 0;
const node_buffer_1 = require("node:buffer");
const splitAt = (string, index) => {
    return [
        index === -1 ? '' : string.substring(0, index),
        index === -1 ? '' : string.substring(index + 1),
    ];
};
const parseAuthorizationHeader = (header) => {
    if (header) {
        header = header.trim();
    }
    if (!header) {
        return null;
    }
    const [type, data] = splitAt(header, header.indexOf(' '));
    // https://datatracker.ietf.org/doc/html/rfc7617#page-3
    // Note that both scheme and parameter names are matched case-
    // insensitively.
    if (type.toLowerCase() !== 'basic') {
        return { type, data };
    }
    const auth = node_buffer_1.Buffer.from(data, 'base64').toString();
    // https://datatracker.ietf.org/doc/html/rfc7617#page-5
    // To receive authorization, the client
    //
    // 1.  obtains the user-id and password from the user,
    //
    // 2.  constructs the user-pass by concatenating the user-id, a single
    //     colon (":") character, and the password,
    //
    // 3.  encodes the user-pass into an octet sequence (see below for a
    //     discussion of character encoding schemes),
    //
    // 4.  and obtains the basic-credentials by encoding this octet sequence
    //     using Base64 ([RFC4648], Section 4) into a sequence of US-ASCII
    //     characters ([RFC0020]).
    // Note:
    // If there's a colon : missing, we imply that the user-pass string is just a username.
    // This is a non-spec behavior. At Apify there are clients that rely on this.
    // If you want this behavior changed, please open an issue.
    const [username, password] = auth.includes(':') ? splitAt(auth, auth.indexOf(':')) : [auth, ''];
    return {
        type,
        data,
        username,
        password,
    };
};
exports.parseAuthorizationHeader = parseAuthorizationHeader;
//# sourceMappingURL=parse_authorization_header.js.map