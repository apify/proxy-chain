const { expect } = require('chai');
const net = require('net');
const portastic = require('portastic');
const {
    redactUrl, isHopByHopHeader,
    parseProxyAuthorizationHeader, addHeader,
    nodeify, maybeAddProxyAuthorizationHeader,
} = require('../src/tools');

/* global describe, it */

const PORT_SELECTION_CONFIG = {
    FROM: 20000,
    TO: 60000,
    RETRY_COUNT: 10,
};

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

describe('tools.parseProxyAuthorizationHeader()', () => {
    it('works with valid input', () => {
        const parse = parseProxyAuthorizationHeader;

        expect(parse(authStr('Basic', 'username:password'))).to.eql({ type: 'Basic', username: 'username', password: 'password' });
        expect(parse(authStr('Basic', 'user1234:password567'))).to.eql({ type: 'Basic', username: 'user1234', password: 'password567' });
        // eslint-disable-next-line max-len
        expect(parse(authStr('Basic', 'username:pass:with:many:colons'))).to.eql({ type: 'Basic', username: 'username', password: 'pass:with:many:colons' });
        expect(parse(authStr('Basic', 'username:'))).to.eql({ type: 'Basic', username: 'username', password: '' });
        expect(parse(authStr('Basic', 'username'))).to.eql({ type: 'Basic', username: 'username', password: '' });
        expect(parse(authStr('Basic', ':'))).to.eql({ type: 'Basic', username: '', password: '' });
        expect(parse(authStr('Basic', ':passWord'))).to.eql({ type: 'Basic', username: '', password: 'passWord' });
        expect(parse(authStr('SCRAM-SHA-256', 'something:else'))).to.eql({ type: 'SCRAM-SHA-256', username: 'something', password: 'else' });
    });

    it('works with invalid input', () => {
        const parse = parseProxyAuthorizationHeader;

        expect(parse(null)).to.eql(null);
        expect(parse('')).to.eql(null);
        expect(parse('    ')).to.eql(null);
        expect(parse('whatever')).to.eql(null);
        expect(parse('bla bla bla')).to.eql(null);
        expect(parse(authStr('Basic', ''))).to.eql(null);
        expect(parse('123124')).to.eql(null);
    });
});

describe('tools.addHeader()', () => {
    it('works for new header', () => {
        const headers = {
            foo: 'bar',
        };

        addHeader(headers, 'someHeaderName', 'someHeaderValue');

        expect(headers).to.be.eql({
            foo: 'bar',
            someHeaderName: 'someHeaderValue',
        });
    });

    it('works for existing single header with the same name', () => {
        const headers = {
            foo: 'bar',
            someHeaderName: 'originalValue',
        };

        addHeader(headers, 'someHeaderName', 'newValue');

        expect(headers).to.be.eql({
            foo: 'bar',
            someHeaderName: ['originalValue', 'newValue'],
        });
    });

    it('works for existing multiple headers with the same name', () => {
        const headers = {
            foo: 'bar',
            someHeaderName: ['originalValue1', 'originalValue2'],
        };

        addHeader(headers, 'someHeaderName', 'newValue');

        expect(headers).to.be.eql({
            foo: 'bar',
            someHeaderName: ['originalValue1', 'originalValue2', 'newValue'],
        });
    });
});

describe('tools.maybeAddProxyAuthorizationHeader()', () => {
    it('works', () => {
        const parsedUrl1 = new URL('http://example.com');
        const headers1 = { AAA: 123 };
        maybeAddProxyAuthorizationHeader(parsedUrl1, headers1);
        expect(headers1).to.eql({
            AAA: 123,
        });

        const parsedUrl2 = new URL('http://aladdin:opensesame@userexample.com');
        const headers2 = { BBB: 123 };
        maybeAddProxyAuthorizationHeader(parsedUrl2, headers2);
        expect(headers2).to.eql({
            BBB: 123,
            'Proxy-Authorization': 'Basic YWxhZGRpbjpvcGVuc2VzYW1l',
        });

        const parsedUrl3 = new URL('http://ala%35ddin:opensesame@userexample.com');
        const headers3 = { BBB: 123 };
        maybeAddProxyAuthorizationHeader(parsedUrl3, headers3);
        expect(headers3).to.eql({
            BBB: 123,
            'Proxy-Authorization': 'Basic YWxhNWRkaW46b3BlbnNlc2FtZQ==',
        });

        const parsedUrl4 = new URL('http://ala%3Addin:opensesame@userexample.com');
        const headers4 = { BBB: 123 };
        expect(() => {
            maybeAddProxyAuthorizationHeader(parsedUrl4, headers4);
        }).to.throw(/The proxy username cannot contain the colon/);
    });
});

const asyncFunction = async (throwError) => {
    if (throwError) throw new Error('Test error');
    return 123;
};

describe('tools.nodeify()', () => {
    it('works', async () => {
        {
            // Test promised result
            const promise = asyncFunction(false);
            const result = await nodeify(promise, null);
            expect(result).to.eql(123);
        }

        {
            // Test promised exception
            const promise = asyncFunction(true);
            let result;
            try {
                result = await nodeify(promise, null);
                throw new Error('This should not be reached!');
            } catch (e) {
                expect(e.message).to.eql('Test error');
            }
        }

        {
            // Test callback result
            const promise = asyncFunction(false);
            await new Promise((resolve) => {
                nodeify(promise, (error, result) => {
                    expect(result).to.eql(123);
                    resolve();
                });
            });
        }

        {
            // Test callback error
            const promise = asyncFunction(true);
            await new Promise((resolve) => {
                nodeify(promise, (error, result) => {
                    expect(error.message).to.eql('Test error');
                    resolve();
                });
            });
        }
    });
});

module.exports = {
    PORT_SELECTION_CONFIG,
};
