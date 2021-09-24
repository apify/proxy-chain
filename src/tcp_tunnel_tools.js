const net = require('net');
const { chain } = require('./chain');
const { nodeify } = require('./utils/nodeify');

const runningServers = {};

const getAddress = (server) => {
    const { address: host, port, family } = server.address();

    if (family === 'IPv6') {
        return `[${host}]:${port}`;
    }

    return `${host}:${port}`;
};

function createTunnel(proxyUrl, targetHost, options, callback) {
    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol !== 'http:') {
        throw new Error(`The proxy URL must have the "http" protocol (was "${proxyUrl}")`);
    }

    const url = new URL(`connect://${targetHost || ''}`);

    if (!url.hostname) {
        throw new Error('Missing target hostname');
    }

    if (!url.port) {
        throw new Error('Missing target port');
    }

    const verbose = options && options.verbose;

    const server = net.createServer();

    const log = (...args) => {
        if (verbose) console.log(...args);
    };

    server.log = log;

    server.on('connection', (sourceSocket) => {
        const remoteAddress = `${sourceSocket.remoteAddress}:${sourceSocket.remotePort}`;

        const { connections } = runningServers[getAddress(server)];

        log(`new client connection from ${remoteAddress}`);

        sourceSocket.on('close', (hadError) => {
            connections.delete(sourceSocket);

            log(`connection from ${remoteAddress} closed, hadError=${hadError}`);
        });

        connections.add(sourceSocket);

        chain({
            request: { url: targetHost },
            sourceSocket,
            handlerOpts: { upstreamProxyUrlParsed: parsedProxyUrl },
            server,
            isPlain: true,
        });
    });

    const promise = new Promise((resolve, reject) => {
        server.once('error', reject);

        // Let the system pick a random listening port
        server.listen(0, () => {
            const address = getAddress(server);

            server.off('error', reject);
            runningServers[address] = { server, connections: new Set() };

            log('server listening to ', address);

            resolve(address);
        });
    });

    return nodeify(promise, callback);
}

module.exports.createTunnel = createTunnel;

function closeTunnel(serverPath, closeConnections, callback) {
    const { hostname, port } = new URL(`tcp://${serverPath}`);
    if (!hostname) throw new Error('serverPath must contain hostname');
    if (!port) throw new Error('serverPath must contain port');

    const promise = new Promise((resolve) => {
        if (!runningServers[serverPath]) return resolve(false);
        if (!closeConnections) return resolve(true);
        for (const connection of runningServers[serverPath].connections) {
            connection.destroy();
        }
        resolve(true);
    })
        .then((serverExists) => new Promise((resolve) => {
            if (!serverExists) return resolve(false);
            runningServers[serverPath].server.close(() => {
                delete runningServers[serverPath];
                resolve(true);
            });
        }));

    return nodeify(promise, callback);
}

module.exports.closeTunnel = closeTunnel;
