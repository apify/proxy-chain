const { decodeURIComponentSafe } = require('./decode_uri_component_safe');

const getBasic = (url) => {
    const username = decodeURIComponentSafe(url.username);
    const password = decodeURIComponentSafe(url.password);
    const auth = `${username}:${password}`;

    if (username.includes(':')) {
        throw new Error('Username contains an invalid colon');
    }

    return `Basic ${Buffer.from(auth).toString('base64')}`;
};

module.exports.getBasic = getBasic;
