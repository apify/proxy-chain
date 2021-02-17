import net from 'net';
import TcpTunnel from './tcp_tunnel';
import { parseUrl, nodeify } from './tools';

const runningServers = {};

export function createTunnel(proxyUrl, targetHost, providedOptions = {}, callback) {
    const parsedProxyUrl = parseUrl(proxyUrl);
    if (!parsedProxyUrl.hostname || !parsedProxyUrl.port) {
        throw new Error(`The proxy URL must contain hostname and port (was "${proxyUrl}")`);
    }
    if (parsedProxyUrl.protocol !== 'http:') {
        throw new Error(`The proxy URL must have the "http" protocol (was "${proxyUrl}")`);
    }
    if (/:/.test(parsedProxyUrl.username)) {
        throw new Error('The proxy URL username cannot contain the colon (:) character according to RFC 7617.');
    }

    // TODO: More and better validations - yeah, make sure targetHost is really a hostname
    const [trgHostname, trgPort] = (targetHost || '').split(':');
    if (!trgHostname || !trgPort) throw new Error('The target host needs to include both hostname and port.');

    const options = {
        verbose: false,
        hostname: 'localhost',
        port: null,
        ...providedOptions,
    };

    const server = net.createServer();

    const log = (...args) => {
        if (options.verbose) console.log(...args);
    };

    server.on('connection', (srcSocket) => {
        const port = server.address().port;

        runningServers[port].connections = srcSocket;
        const remoteAddress = `${srcSocket.remoteAddress}:${srcSocket.remotePort}`;
        log('new client connection from %s', remoteAddress);

        srcSocket.pause();

        const tunnel = new TcpTunnel({
            srcSocket,
            upstreamProxyUrlParsed: parsedProxyUrl,
            trgParsed: {
                hostname: trgHostname,
                port: trgPort,
            },
            log,
        });

        tunnel.run();

        srcSocket.on('data', onConnData);
        srcSocket.on('close', onConnClose);
        srcSocket.on('error', onConnError);

        function onConnData(d) {
            log('connection data from %s: %j', remoteAddress, d);
        }

        function onConnClose() {
            log('connection from %s closed', remoteAddress);
        }

        function onConnError(err) {
            log('Connection %s error: %s', remoteAddress, err.message);
        }
    });

    const promise = new Promise((resolve) => {
        // Let the system pick a random listening port
        server.listen(0, (err) => {
            if (err) return reject(err);
            const address = server.address();
            log('server listening to ', address);
            runningServers[address.port] = { server, connections: [] };
            resolve(`${options.hostname}:${address.port}`);
        });
    });

    return nodeify(promise, callback);
}

export function closeTunnel(serverPath, closeConnections, callback) {
    const [hostname, port] = serverPath.split(':');
    if (!hostname) throw new Error('serverPath must contain hostname');
    if (!port) throw new Error('serverPath must contain port');

    const promise = new Promise((resolve) => {
        if (!runningServers[port]) return resolve(false);
        if (!closeConnections) return resolve(true);
        runningServers[port].connections.forEach((connection) => connection.destroy());
        resolve(true);
    })
        .then((serverExists) => new Promise((resolve) => {
            if (!serverExists) return resolve(false);
            runningServers[port].server.close(() => {
                delete runningServers[port];
                resolve(true);
            });
        }));

    return nodeify(promise, callback);
}
