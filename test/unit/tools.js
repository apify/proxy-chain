import { describe, expect, it } from 'vitest';
import { redactUrl } from '../../src/utils/redact_url.js';
import { isHopByHopHeader } from '../../src/utils/is_hop_by_hop_header.js';
import { parseAuthorizationHeader } from '../../src/utils/parse_authorization_header.js';

describe('tools.redactUrl()', () => {
    it('works', () => {
        // Test that the function lower-cases the schema and path
        expect(redactUrl('HTTPS://username:password@WWW.EXAMPLE.COM:1234/path#hash'))
            .toBe('https://username:<redacted>@www.example.com:1234/path#hash');

        expect(redactUrl('https://username@www.example.com:1234/path#hash'))
            .toBe('https://username@www.example.com:1234/path#hash');

        expect(redactUrl('https://username:password@www.example.com:1234/path#hash', '<xxx>'))
            .toBe('https://username:<xxx>@www.example.com:1234/path#hash');

        expect(redactUrl('ftp://@www.example.com/path/path2'))
            .toBe('ftp://www.example.com/path/path2');

        expect(redactUrl('ftp://www.example.com'))
            .toBe('ftp://www.example.com/');

        expect(redactUrl('ftp://example.com/'))
            .toBe('ftp://example.com/');

        expect(redactUrl('http://username:p@%%w0rd@[2001:db8:85a3:8d3:1319:8a2e:370:7348]:12345/'))
            .toBe('http://username:<redacted>@[2001:db8:85a3:8d3:1319:8a2e:370:7348]:12345/');
    });
});

describe('tools.isHopByHopHeader()', () => {
    it('works', () => {
        expect(isHopByHopHeader('Connection')).toBe(true);
        expect(isHopByHopHeader('connection')).toBe(true);
        expect(isHopByHopHeader('Proxy-Authorization')).toBe(true);
        expect(isHopByHopHeader('upGrade')).toBe(true);

        expect(isHopByHopHeader('Host')).toBe(false);
        expect(isHopByHopHeader('Whatever')).toBe(false);
        expect(isHopByHopHeader('')).toBe(false);
    });
});

const authStr = (type, usernameAndPassword) => {
    return `${type} ${Buffer.from(usernameAndPassword).toString('base64')}`;
};

describe('tools.parseAuthorizationHeader()', () => {
    it('works with valid input', () => {
        const parse = parseAuthorizationHeader;

        expect(parse(authStr('Basic', 'username:password'))).toStrictEqual({
            type: 'Basic',
            username: 'username',
            password: 'password',
            data: 'dXNlcm5hbWU6cGFzc3dvcmQ=',
        });

        expect(parse(authStr('Basic', 'user1234:password567'))).toStrictEqual({
            type: 'Basic',
            username: 'user1234',
            password: 'password567',
            data: 'dXNlcjEyMzQ6cGFzc3dvcmQ1Njc=',
        });

        expect(parse(authStr('Basic', 'username:pass:with:many:colons'))).toStrictEqual({
            type: 'Basic',
            username: 'username',
            password: 'pass:with:many:colons',
            data: 'dXNlcm5hbWU6cGFzczp3aXRoOm1hbnk6Y29sb25z',
        });

        expect(parse(authStr('Basic', 'username:'))).toStrictEqual({
            type: 'Basic',
            username: 'username',
            password: '',
            data: 'dXNlcm5hbWU6',
        });

        // Do not alter this test, see comment in src/utils/parse_authorization_header.ts
        expect(parse(authStr('Basic', 'username'))).toStrictEqual({
            type: 'Basic',
            username: 'username',
            password: '',
            data: 'dXNlcm5hbWU=',
        });

        expect(parse(authStr('Basic', ':'))).toStrictEqual({
            type: 'Basic',
            username: '',
            password: '',
            data: 'Og==',
        });

        expect(parse(authStr('Basic', ':passWord'))).toStrictEqual({
            type: 'Basic',
            username: '',
            password: 'passWord',
            data: 'OnBhc3NXb3Jk',
        });

        expect(parse(authStr('SCRAM-SHA-256', 'something:else'))).toStrictEqual({
            type: 'SCRAM-SHA-256',
            data: 'c29tZXRoaW5nOmVsc2U=',
        });
    });

    it('works with invalid input', () => {
        const parse = parseAuthorizationHeader;

        expect(parse(null)).toBe(null);
        expect(parse('')).toBe(null);
        expect(parse('    ')).toBe(null);

        expect(parse('whatever')).toStrictEqual({
            type: '',
            data: '',
        });

        expect(parse('bla bla bla')).toStrictEqual({
            type: 'bla',
            data: 'bla bla',
        });

        expect(parse(authStr('Basic', ''))).toStrictEqual({
            type: '',
            data: '',
        });

        expect(parse('123124')).toStrictEqual({
            type: '',
            data: '',
        });
    });
});
