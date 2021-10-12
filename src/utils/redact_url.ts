<<<<<<< HEAD
import { URL } from 'node:url';
=======
import { URL } from 'url';
>>>>>>> f1bbe42 (release: 2.0.0 (#162))

export const redactUrl = (url: string | URL, passwordReplacement = '<redacted>'): string => {
    if (typeof url !== 'object') {
        url = new URL(url);
    }

    if (url.password) {
        return url.href.replace(`:${url.password}`, `:${passwordReplacement}`);
    }

    return url.href;
};
