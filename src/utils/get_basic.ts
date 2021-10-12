<<<<<<< HEAD
import type { URL } from 'node:url';

=======
import { URL } from 'url';
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
import { decodeURIComponentSafe } from './decode_uri_component_safe';

export const getBasicAuthorizationHeader = (url: URL): string => {
    const username = decodeURIComponentSafe(url.username);
    const password = decodeURIComponentSafe(url.password);
    const auth = `${username}:${password}`;

    if (username.includes(':')) {
        throw new Error('Username contains an invalid colon');
    }

    return `Basic ${Buffer.from(auth).toString('base64')}`;
};
