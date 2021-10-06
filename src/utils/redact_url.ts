import { URL } from 'url';

export const redactUrl = (url: string | URL, passwordReplacement = '<redacted>'): string => {
    if (typeof url !== 'object') {
        url = new URL(url);
    }

    if (url.password) {
        return url.href.replace(`:${url.password}`, `:${passwordReplacement}`);
    }

    return url.href;
};
