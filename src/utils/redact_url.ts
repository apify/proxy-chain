import { URL } from 'node:url';

export const redactUrl = (url: string | URL, passwordReplacement = '<redacted>'): string => {
    if (typeof url !== 'object') {
        url = new URL(url);
    }

    if (url.password) {
        // Use the URL's internal encoded password representation for replacement
        // We need to rebuild the userinfo part to handle URL-encoded passwords correctly
        const redactedUrl = new URL(url.href);
        redactedUrl.password = passwordReplacement;
        return redactedUrl.href;
    }

    return url.href;
};
