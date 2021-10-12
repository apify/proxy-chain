const splitAt = (string: string, index: number) => {
    return [
        index === -1 ? '' : string.substring(0, index),
        index === -1 ? '' : string.substring(index + 1),
    ];
};

interface Authorization {
    type: string;
    data: string;
    username?: string;
    password?: string;
}

export const parseAuthorizationHeader = (header: string): Authorization | null => {
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
