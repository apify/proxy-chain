const { expect } = require('chai');
const net = require('net');
const portastic = require('portastic');
const {
    parseUrl, redactUrl, parseHostHeader, isHopByHopHeader, isInvalidHeader,
    parseProxyAuthorizationHeader, addHeader,
    nodeify, maybeAddProxyAuthorizationHeader,
} = require('../build/tools');

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
            if (ports.length < 1) throw new Error(`There are no more free ports in range from ${PORT_SELECTION_CONFIG.FROM} to ${PORT_SELECTION_CONFIG.TO}`); // eslint-disable-line max-len
            return ports[0];
        });
};

const testUrl = (url, expected) => {
    const parsed1 = parseUrl(url);
    expect(parsed1).to.contain(expected);
};

describe('tools.parseUrl()', () => {
    it('works', () => {
        testUrl('https://username:password@www.example.COM:12345/some/path', {
            auth: 'username:password',
            protocol: 'https:',
            scheme: 'https',
            username: 'username',
            password: 'password',
            host: 'www.example.com:12345',
            hostname: 'www.example.com',
            port: 12345,
        });

        testUrl('https://username:password@www.example.com/some/path', {
            auth: 'username:password',
            protocol: 'https:',
            scheme: 'https',
            username: 'username',
            password: 'password',
            host: 'www.example.com',
            hostname: 'www.example.com',
            port: 443,
            path: '/some/path',
        });

        testUrl('http://us-er+na12345me:@WWW.EXAMPLE.COM:12345/some/path', {
            auth: 'us-er+na12345me:',
            protocol: 'http:',
            scheme: 'http',
            username: 'us-er+na12345me',
            password: '',
            host: 'www.example.com:12345',
            hostname: 'www.example.com',
            port: 12345,
            path: '/some/path',
        });

        testUrl('https://EXAMPLE.COM:12345/some/path', {
            auth: '',
            protocol: 'https:',
            scheme: 'https',
            username: '',
            password: '', // not null!
            host: 'example.com:12345',
            hostname: 'example.com',
            port: 12345,
            path: '/some/path',
        });

        testUrl('https://:passwrd@EXAMPLE.COM:12345/some/path', {
            auth: ':passwrd',
            protocol: 'https:',
            scheme: 'https',
            username: '',
            password: 'passwrd',
            host: 'example.com:12345',
            hostname: 'example.com',
            port: 12345,
            path: '/some/path',
        });

        testUrl('socks5://username@EXAMPLE.com:12345/some/path', {
            auth: 'username:',
            protocol: 'socks5:',
            scheme: 'socks5',
            username: 'username',
            password: '',
            // TODO: Why the hell it's UPPERCASE here??? And lower-case above for EXAMPLE.COM ?
            host: 'EXAMPLE.com:12345',
            hostname: 'EXAMPLE.com',
            port: 12345,
        });

        testUrl('FTP://@FTP.EXAMPLE.COM:12345/some/path', {
            auth: '',
            protocol: 'ftp:',
            scheme: 'ftp',
            username: '',
            password: '',
            hostname: 'ftp.example.com',
            port: 12345,
        });

        testUrl('HTTP://www.example.com:12345/some/path', {
            protocol: 'http:',
            scheme: 'http',
            username: '',
            password: '',
            hostname: 'www.example.com',
            port: 12345,
            path: '/some/path',
        });

        testUrl('HTTP://www.example.com/some/path', {
            protocol: 'http:',
            scheme: 'http',
            username: '',
            password: '',
            port: 80,
        });

        testUrl('http://[2001:db8:85a3:8d3:1319:8a2e:370:7348]/', {
            protocol: 'http:',
            scheme: 'http',
            username: '',
            password: '',
            hostname: '[2001:db8:85a3:8d3:1319:8a2e:370:7348]',
            port: 80,
        });

        testUrl('http://[2001:db8:85a3:8d3:1319:8a2e:370:7348]:12345/', {
            protocol: 'http:',
            scheme: 'http',
            username: '',
            password: '',
            hostname: '[2001:db8:85a3:8d3:1319:8a2e:370:7348]',
            port: 12345,
        });

        // Note the upper-case "DB" here and lower-case "db" below
        testUrl('http://username:password@[2001:DB8:85a3:8d3:1319:8a2e:370:7348]:12345/', {
            protocol: 'http:',
            scheme: 'http',
            username: 'username',
            password: 'password',
            host: '[2001:db8:85a3:8d3:1319:8a2e:370:7348]:12345',
            hostname: '[2001:db8:85a3:8d3:1319:8a2e:370:7348]',
            port: 12345,
        });

        testUrl('http://user%35name:p%%w0rd@EXAMPLE.COM:12345/', {
            protocol: 'http:',
            scheme: 'http',
            username: 'user5name',
            password: 'p%%w0rd',
            hostname: 'example.com',
            port: 12345,
            path: '/',
        });

        // Test that default ports are added for http and https
        testUrl('https://www.example.com', { port: 443 });
        testUrl('http://www.example.com', { port: 80 });
        // ... and for web sockets
        testUrl('wss://www.example.com', { port: 443 });
        testUrl('ws://www.example.com', { port: 80 });
        // Test that default port is not added for other protocols
        testUrl('socks5://www.example.com', { port: null });
        testUrl('socks5://www.example.com:1080', { port: 1080 });
        // Test that explicit port is returned when specified
        testUrl('https://www.example.com:12345', { port: 12345 });
        testUrl('http://www.example.com:12345', { port: 12345 });

        expect(() => {
            parseUrl('/some-relative-url?a=1');
        }).to.throw(/Invalid URL/);

        expect(() => {
            parseUrl('A nonsense, really.');
        }).to.throw(/Invalid URL/);
    });
});

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

describe('tools.parseHostHeader()', () => {
    it('works with valid input', () => {
        expect(parseHostHeader('www.example.com:80')).to.eql({ hostname: 'www.example.com', port: 80 });
        expect(parseHostHeader('something:1')).to.eql({ hostname: 'something', port: 1 });
        expect(parseHostHeader('something:65535')).to.eql({ hostname: 'something', port: 65535 });
        expect(parseHostHeader('example.com')).to.eql({ hostname: 'example.com', port: null });
        expect(parseHostHeader('1.2.3.4')).to.eql({ hostname: '1.2.3.4', port: null });
        expect(parseHostHeader('1.2.3.4:5555')).to.eql({ hostname: '1.2.3.4', port: 5555 });
        expect(parseHostHeader('a.b.c.d.e.f.g:1')).to.eql({ hostname: 'a.b.c.d.e.f.g', port: 1 });
    });

    it('works with invalid input', () => {
        expect(parseHostHeader(null)).to.eql(null);
        expect(parseHostHeader('')).to.eql(null);
        expect(parseHostHeader('bla bla')).to.eql(null);
        expect(parseHostHeader('     ')).to.eql(null);
        expect(parseHostHeader('   :  ')).to.eql(null);
        expect(parseHostHeader('12 34')).to.eql(null);
        expect(parseHostHeader('example.com:')).to.eql(null);
        expect(parseHostHeader('example.com:0')).to.eql(null);
        expect(parseHostHeader('example.com:65536')).to.eql(null);
        expect(parseHostHeader('example.com:999999')).to.eql(null);

        let LONG_HOSTNAME = '';
        for (let i = 0; i <= 256; i++) { LONG_HOSTNAME += 'a'; }
        expect(parseHostHeader(LONG_HOSTNAME)).to.eql(null);
        expect(parseHostHeader(`${LONG_HOSTNAME}:123`)).to.eql(null);
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
        expect(parse(authStr('Basic', 'username:pass:with:many:colons'))).to.eql({ type: 'Basic', username: 'username', password: 'pass:with:many:colons' }); //eslint-disable-line
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
        const parsedUrl1 = parseUrl('http://example.com');
        const headers1 = { AAA: 123 };
        maybeAddProxyAuthorizationHeader(parsedUrl1, headers1);
        expect(headers1).to.eql({
            AAA: 123,
        });

        const parsedUrl2 = parseUrl('http://aladdin:opensesame@userexample.com');
        const headers2 = { BBB: 123 };
        maybeAddProxyAuthorizationHeader(parsedUrl2, headers2);
        expect(headers2).to.eql({
            BBB: 123,
            'Proxy-Authorization': 'Basic YWxhZGRpbjpvcGVuc2VzYW1l',
        });

        const parsedUrl3 = parseUrl('http://ala%35ddin:opensesame@userexample.com');
        const headers3 = { BBB: 123 };
        maybeAddProxyAuthorizationHeader(parsedUrl3, headers3);
        expect(headers3).to.eql({
            BBB: 123,
            'Proxy-Authorization': 'Basic YWxhNWRkaW46b3BlbnNlc2FtZQ==',
        });

        const parsedUrl4 = parseUrl('http://ala%3Addin:opensesame@userexample.com');
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
