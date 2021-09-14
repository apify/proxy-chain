/**
 * Redacts password from a URL, so that it can be shown in logs, results etc.
 * For example, converts URL such as
 * 'https://username:password@www.example.com/path#hash'
 * to 'https://username:<redacted>@www.example.com/path#hash'
 * @param url URL, it must contain at least protocol and hostname
 * @param passwordReplacement The string that replaces password, by default it is '<redacted>'
 * @returns {string}
 * @ignore
 */
const redactUrl = (url, passwordReplacement = '<redacted>') => {
    if (typeof url !== 'object') {
        url = new URL(url);
    }

    if (url.password) {
        return url.href.replace(`:${url.password}`, `:${passwordReplacement}`);
    }

    return url.href;
};

module.exports.redactUrl = redactUrl;
