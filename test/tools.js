const { expect } = require('chai');
const net = require('net');
const portastic = require('portastic');
const {
    redactUrl, isHopByHopHeader, isInvalidHeader,
    parseProxyAuthorizationHeader, addHeader,
    nodeify, maybeAddProxyAuthorizationHeader,
} = require('../src/tools');

/* global describe, it */

const PORT_SELECTION_CONFIG = {
    FROM: 20000,
    TO: 60000,
    RETRY_COUNT: 10,
};

const findFreePort = () => {
    // Let 'min' be a random value in the first half of the PORT_FROM-PORT_TO range,
    // to reduce a chance of collision if other ProxyChain is started at the same time.
    const half = Math.floor((PORT_SELECTION_CONFIG.TO - PORT_SELECTION_CONFIG.FROM) / 2);

    const opts = {
        min: PORT_SELECTION_CONFIG.FROM + Math.floor(Math.random() * half),
        max: PORT_SELECTION_CONFIG.TO,
        retrieve: 1,
    };

    return portastic.find(opts)
        .then((ports) => {
            if (ports.length < 1) {
                throw new Error(`There are no more free ports in range from ${PORT_SELECTION_CONFIG.FROM} to ${PORT_SELECTION_CONFIG.TO}`);
            }
            return ports[0];
        });
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

describe('tools.isInvalidHeader()', () => {
    it('works', () => {
        expect(isInvalidHeader('With space', 'a')).to.eql(true);
        expect(isInvalidHeader('', 'a')).to.eql(true);
        expect(isInvalidHeader(undefined, 'a')).to.eql(true);
        expect(isInvalidHeader(null, 'a')).to.eql(true);
        expect(isInvalidHeader(1234, 'a')).to.eql(true);
        expect(isInvalidHeader('\n', 'a')).to.eql(true);
        expect(isInvalidHeader('', 'a')).to.eql(true);
        expect(isInvalidHeader(' ', 'a')).to.eql(true);
        expect(isInvalidHeader('\u3042', 'a')).to.eql(true);
        expect(isInvalidHeader('\u3042a', 'a')).to.eql(true);
        expect(isInvalidHeader('aaaa\u3042aaaa', 'a')).to.eql(true);

        expect(isInvalidHeader('connection', 'a')).to.eql(false);
        expect(isInvalidHeader('Proxy-Authorization', 'a')).to.eql(false);
        expect(isInvalidHeader('upGrade', 'a')).to.eql(false);
        expect(isInvalidHeader('Host', 'a')).to.eql(false);
        expect(isInvalidHeader('Whatever', 'a')).to.eql(false);
        expect(isInvalidHeader('t', 'a')).to.eql(false);
        expect(isInvalidHeader('tt', 'a')).to.eql(false);
        expect(isInvalidHeader('ttt', 'a')).to.eql(false);
        expect(isInvalidHeader('tttt', 'a')).to.eql(false);
        expect(isInvalidHeader('ttttt', 'a')).to.eql(false);

        expect(isInvalidHeader('a', '\u3042')).to.eql(true);
        expect(isInvalidHeader('a', 'aaaa\u3042aaaa')).to.eql(true);
        expect(isInvalidHeader('aaa', 'bla\vbla')).to.eql(true);

        expect(isInvalidHeader('a', '')).to.eql(false);
        expect(isInvalidHeader('a', 1)).to.eql(false);
        expect(isInvalidHeader('a', ' ')).to.eql(false);
        expect(isInvalidHeader('a', false)).to.eql(false);
        expect(isInvalidHeader('a', 't')).to.eql(false);
        expect(isInvalidHeader('a', 'tt')).to.eql(false);
        expect(isInvalidHeader('a', 'ttt')).to.eql(false);
        expect(isInvalidHeader('a', 'tttt')).to.eql(false);
        expect(isInvalidHeader('a', 'ttttt')).to.eql(false);
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

describe('tools.findFreePort()', () => {
    it('throws nice error when no more free ports available', () => {
        const server = net.createServer();
        const startServer = ports => new Promise((resolve, reject) => {
            server.listen(ports[0], (err) => {
                if (err) return reject(err);
                resolve(ports[0]);
            });
        });
        const PORT_SELECTION_CONFIG_BACKUP = { ...PORT_SELECTION_CONFIG };
        return portastic.find({ min: 50000, max: 50100 })
            .then(startServer)
            .then((port) => {
                PORT_SELECTION_CONFIG.FROM = port;
                PORT_SELECTION_CONFIG.TO = port;
                return findFreePort();
            })
            .then(() => assert.fail())
            .catch((err) => {
                expect(err.message).to.contain('There are no more free ports');
            })
            .finally(() => {
                PORT_SELECTION_CONFIG.FROM = PORT_SELECTION_CONFIG_BACKUP.FROM;
                PORT_SELECTION_CONFIG.TO = PORT_SELECTION_CONFIG_BACKUP.TO;
                if (server.listening) server.close();
            });
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
    findFreePort,
};
