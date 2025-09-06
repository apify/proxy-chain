"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.direct = void 0;
const tslib_1 = require("tslib");
const node_net_1 = tslib_1.__importDefault(require("node:net"));
const node_url_1 = require("node:url");
const count_target_bytes_1 = require("./utils/count_target_bytes");
/**
 * Directly connects to the target.
 * Client -> Apify (CONNECT) -> Web
 * Client <- Apify (CONNECT) <- Web
 */
const direct = ({ request, sourceSocket, head, server, handlerOpts, }) => {
    const url = new node_url_1.URL(`connect://${request.url}`);
    if (!url.hostname) {
        throw new Error('Missing CONNECT hostname');
    }
    if (!url.port) {
        throw new Error('Missing CONNECT port');
    }
    if (head.length > 0) {
        // See comment in chain.ts
        sourceSocket.unshift(head);
    }
    const options = {
        port: Number(url.port),
        host: url.hostname,
        localAddress: handlerOpts.localAddress,
        family: handlerOpts.ipFamily,
        lookup: handlerOpts.dnsLookup,
    };
    if (options.host[0] === '[') {
        options.host = options.host.slice(1, -1);
    }
    const targetSocket = node_net_1.default.createConnection(options, () => {
        try {
            sourceSocket.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
        }
        catch (error) {
            sourceSocket.destroy(error);
        }
    });
    (0, count_target_bytes_1.countTargetBytes)(sourceSocket, targetSocket);
    sourceSocket.pipe(targetSocket);
    targetSocket.pipe(sourceSocket);
    // Once target socket closes forcibly, the source socket gets paused.
    // We need to enable flowing, otherwise the socket would remain open indefinitely.
    // Nothing would consume the data, we just want to close the socket.
    targetSocket.on('close', () => {
        sourceSocket.resume();
        if (sourceSocket.writable) {
            sourceSocket.end();
        }
    });
    // Same here.
    sourceSocket.on('close', () => {
        targetSocket.resume();
        if (targetSocket.writable) {
            targetSocket.end();
        }
    });
    const { proxyChainId } = sourceSocket;
    targetSocket.on('error', (error) => {
        server.log(proxyChainId, `Direct Destination Socket Error: ${error.stack}`);
        sourceSocket.destroy();
    });
    sourceSocket.on('error', (error) => {
        server.log(proxyChainId, `Direct Source Socket Error: ${error.stack}`);
        targetSocket.destroy();
    });
};
exports.direct = direct;
//# sourceMappingURL=direct.js.map