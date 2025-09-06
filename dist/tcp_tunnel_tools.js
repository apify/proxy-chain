"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeTunnel = exports.createTunnel = void 0;
const tslib_1 = require("tslib");
const node_net_1 = tslib_1.__importDefault(require("node:net"));
const node_url_1 = require("node:url");
const chain_1 = require("./chain");
const nodeify_1 = require("./utils/nodeify");
const runningServers = {};
const getAddress = (server) => {
    const { address: host, port, family } = server.address();
    if (family === 'IPv6') {
        return `[${host}]:${port}`;
    }
    return `${host}:${port}`;
};
async function createTunnel(proxyUrl, targetHost, options, callback) {
    const parsedProxyUrl = new node_url_1.URL(proxyUrl);
    if (!['http:', 'https:'].includes(parsedProxyUrl.protocol)) {
        throw new Error(`The proxy URL must have the "http" or "https" protocol (was "${proxyUrl}")`);
    }
    const url = new node_url_1.URL(`connect://${targetHost || ''}`);
    if (!url.hostname) {
        throw new Error('Missing target hostname');
    }
    if (!url.port) {
        throw new Error('Missing target port');
    }
    const verbose = options && options.verbose;
    const server = node_net_1.default.createServer();
    const log = (...args) => {
        if (verbose)
            console.log(...args);
    };
    server.log = log;
    server.on('connection', (sourceSocket) => {
        var _a;
        const remoteAddress = `${sourceSocket.remoteAddress}:${sourceSocket.remotePort}`;
        const { connections } = runningServers[getAddress(server)];
        log(`new client connection from ${remoteAddress}`);
        sourceSocket.on('close', (hadError) => {
            connections.delete(sourceSocket);
            log(`connection from ${remoteAddress} closed, hadError=${hadError}`);
        });
        connections.add(sourceSocket);
        (0, chain_1.chain)({
            request: { url: targetHost },
            sourceSocket,
            handlerOpts: {
                upstreamProxyUrlParsed: parsedProxyUrl,
                ignoreUpstreamProxyCertificate: (_a = options === null || options === void 0 ? void 0 : options.ignoreProxyCertificate) !== null && _a !== void 0 ? _a : false,
            },
            server: server,
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
    return (0, nodeify_1.nodeify)(promise, callback);
}
exports.createTunnel = createTunnel;
async function closeTunnel(serverPath, closeConnections, callback) {
    const { hostname, port } = new node_url_1.URL(`tcp://${serverPath}`);
    if (!hostname)
        throw new Error('serverPath must contain hostname');
    if (!port)
        throw new Error('serverPath must contain port');
    const promise = new Promise((resolve) => {
        if (!runningServers[serverPath]) {
            resolve(false);
            return;
        }
        if (!closeConnections) {
            resolve(true);
            return;
        }
        for (const connection of runningServers[serverPath].connections) {
            connection.destroy();
        }
        resolve(true);
    })
        .then(async (serverExists) => new Promise((resolve) => {
        if (!serverExists) {
            resolve(false);
            return;
        }
        runningServers[serverPath].server.close(() => {
            delete runningServers[serverPath];
            resolve(true);
        });
    }));
    return (0, nodeify_1.nodeify)(promise, callback);
}
exports.closeTunnel = closeTunnel;
//# sourceMappingURL=tcp_tunnel_tools.js.map