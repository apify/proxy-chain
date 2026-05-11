import { expect } from 'chai';
import { redactUrl } from '../../src/utils/redact_url.js';
import { isHopByHopHeader } from '../../src/utils/is_hop_by_hop_header.js';
import { parseAuthorizationHeader } from '../../src/utils/parse_authorization_header.js';

describe('tools.redactUrl()', () => {
    it('works', () => {
        // Test that the function lower-cases the schema and path
        expect(redactUrl('HTTPS://username:password@WWW.EXAMPLE.COM:1234/path#hash'))
            .to.eql('https://username:<redacted>@www.example.com:1234/path#hash');

        expect(redactUrl('https://username@www.example.com:1234/path#hash'))
            .to.eql('https://username@www.example.com:1234/path#hash');

        expect(redactUrl('https://username:password@www.example.com:1234/path#hash', '<xxx>'))
            .to.eql('https://username:<xxx>@www.example.com:1234/path#hash');

        expect(redactUrl('ftp://@www.example.com/path/path2'))
            .to.eql('ftp://www.example.com/path/path2');

        expect(redactUrl('ftp://www.example.com'))
            .to.eql('ftp://www.example.com/');

        expect(redactUrl('ftp://example.com/'))
            .to.eql('ftp://example.com/');

        expect(redactUrl('http://username:p@%%w0rd@[2001:db8:85a3:8d3:1319:8a2e:370:7348]:12345/'))
            .to.eql('http://username:<redacted>@[2001:db8:85a3:8d3:1319:8a2e:370:7348]:12345/');
    });
});

describe('tools.isHopByHopHeader()', () => {
    it('works', () => {
        expect(isHopByHopHeader('Connection')).to.eql(true);
        expect(isHopByHopHeader('connection')).to.eql(true);
        expect(isHopByHopHeader('Proxy-Authorization')).to.eql(true);
        expect(isHopByHopHeader('upGrade')).to.eql(true);

        expect(isHopByHopHeader('Host')).to.eql(false);
        expect(isHopByHopHeader('Whatever')).to.eql(false);
        expect(isHopByHopHeader('')).to.eql(false);
    });
});

const authStr = (type, usernameAndPassword) => {
    return `${type} ${Buffer.from(usernameAndPassword).toString('base64')}`;
};

describe('tools.parseAuthorizationHeader()', () => {
    it('works with valid input', () => {
        const parse = parseAuthorizationHeader;

        expect(parse(authStr('Basic', 'username:password'))).to.eql({
            type: 'Basic',
            username: 'username',
            password: 'password',
            data: 'dXNlcm5hbWU6cGFzc3dvcmQ=',
        });

        expect(parse(authStr('Basic', 'user1234:password567'))).to.eql({
            type: 'Basic',
            username: 'user1234',
            password: 'password567',
            data: 'dXNlcjEyMzQ6cGFzc3dvcmQ1Njc=',
        });

        expect(parse(authStr('Basic', 'username:pass:with:many:colons'))).to.eql({
            type: 'Basic',
            username: 'username',
            password: 'pass:with:many:colons',
            data: 'dXNlcm5hbWU6cGFzczp3aXRoOm1hbnk6Y29sb25z',
        });

        expect(parse(authStr('Basic', 'username:'))).to.eql({
            type: 'Basic',
            username: 'username',
            password: '',
            data: 'dXNlcm5hbWU6',
        });

        // Do not alter this test, see comment in src/utils/parse_authorization_header.ts
        expect(parse(authStr('Basic', 'username'))).to.eql({
            type: 'Basic',
            username: 'username',
            password: '',
            data: 'dXNlcm5hbWU=',
        });

        expect(parse(authStr('Basic', ':'))).to.eql({
            type: 'Basic',
            username: '',
            password: '',
            data: 'Og==',
        });

        expect(parse(authStr('Basic', ':passWord'))).to.eql({
            type: 'Basic',
            username: '',
            password: 'passWord',
            data: 'OnBhc3NXb3Jk',
        });

        expect(parse(authStr('SCRAM-SHA-256', 'something:else'))).to.eql({
            type: 'SCRAM-SHA-256',
            data: 'c29tZXRoaW5nOmVsc2U=',
        });
    });

    it('works with invalid input', () => {
        const parse = parseAuthorizationHeader;

        expect(parse(null)).to.eql(null);
        expect(parse('')).to.eql(null);
        expect(parse('    ')).to.eql(null);

        expect(parse('whatever')).to.eql({
            type: '',
            data: '',
        });

        expect(parse('bla bla bla')).to.eql({
            type: 'bla',
            data: 'bla bla',
        });

        expect(parse(authStr('Basic', ''))).to.eql({
            type: '',
            data: '',
        });

        expect(parse('123124')).to.eql({
            type: '',
            data: '',
        });
    });
});
