import _ from 'underscore';
import urlModule from 'url';
import { expect } from 'chai';
import net from 'net';
import portastic from 'portastic';
import {
    parseUrl, redactUrl, parseHostHeader, isHopByHopHeader, isInvalidHeader,
    parseProxyAuthorizationHeader, addHeader, findFreePort, PORT_SELECTION_CONFIG,
} from '../build/tools';

/* global process, describe, it */


const testUrl = (url, extras) => {
    const parsed1 = parseUrl(url);
    const parsed2 = urlModule.parse(url);
    expect(parsed1).to.eql(_.extend(parsed2, extras));
};

describe('tools.parseUrl()', () => {
    it('works', () => {
        testUrl('https://username:password@www.example.com:12345/some/path', {
            scheme: 'https',
            username: 'username',
            password: 'password',
            port: 12345,
        });

        testUrl('http://us-er+na12345me:@www.example.com:12345/some/path', {
            scheme: 'http',
            username: 'us-er+na12345me',
            password: '',
            port: 12345,
        });

        testUrl('socks5://username@www.example.com:12345/some/path', {
            scheme: 'socks5',
            username: 'username',
            password: null,
            port: 12345,
        });

        testUrl('FTP://@www.example.com:12345/some/path', {
            scheme: 'ftp',
            username: null,
            password: null,
            port: 12345,
        });

        testUrl('HTTP://www.example.com:12345/some/path', {
            scheme: 'http',
            username: null,
            password: null,
            port: 12345,
        });

        testUrl('HTTP://www.example.com/some/path', {
            scheme: 'http',
            username: null,
            password: null,
            port: null,
        });
    });
});

describe('tools.redactUrl()', () => {
    it('works', () => {
        expect(redactUrl('https://username:password@www.example.com:1234/path#hash'))
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
                PORT_SELECTION_CONFIG.from = PORT_SELECTION_CONFIG_BACKUP.from;
                PORT_SELECTION_CONFIG.to = PORT_SELECTION_CONFIG_BACKUP.to;
                if (server.listening) server.close();
            });
    });
});
