const splitAt = (string, index) => {
    return [
        index === -1 ? '' : string.substring(0, index),
        index === -1 ? '' : string.substring(index + 1),
    ];
};

/**
 * Parses the content of the Proxy-Authorization HTTP header.
 * @param header
 * @returns {*} Object with fields { type: String, username: String, password: String }
 * or null if string parsing failed. Note that password and username might be empty strings.
 */
const parseAuthorizationHeader = (header) => {
    if (header) {
        header = header.trim();
    }

    if (!header) {
        return null;
    }

    const [type, data] = splitAt(header, header.indexOf(' '));

    if (type.toLowerCase() !== 'basic') {
        return { type, data };
    }

    const auth = Buffer.from(data, 'base64').toString();
    const [username, password] = splitAt(auth, auth.indexOf(':'));

    return {
        type,
        data,
        username,
        password,
    };
};

module.exports.parseAuthorizationHeader = parseAuthorizationHeader;
