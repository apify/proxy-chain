"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chainSocks = void 0;
const node_url_1 = require("node:url");
const socks_1 = require("socks");
const statuses_1 = require("./statuses");
const count_target_bytes_1 = require("./utils/count_target_bytes");
const socksProtocolToVersionNumber = (protocol) => {
    switch (protocol) {
        case 'socks4:':
        case 'socks4a:':
            return 4;
        default:
            return 5;
    }
};
/**
 * Client -> Apify (CONNECT) -> Upstream (SOCKS) -> Web
 * Client <- Apify (CONNECT) <- Upstream (SOCKS) <- Web
 */
const chainSocks = async ({ request, sourceSocket, head, server, handlerOpts, }) => {
    const { proxyChainId } = sourceSocket;
    const { hostname, port, username, password } = handlerOpts.upstreamProxyUrlParsed;
    const proxy = {
        host: hostname,
        port: Number(port),
        type: socksProtocolToVersionNumber(handlerOpts.upstreamProxyUrlParsed.protocol),
        userId: decodeURIComponent(username),
        password: decodeURIComponent(password),
    };
    if (head && head.length > 0) {
        // HTTP/1.1 has no defined semantics when sending payload along with CONNECT and servers can reject the request.
        // HTTP/2 only says that subsequent DATA frames must be transferred after HEADERS has been sent.
        // HTTP/3 says that all DATA frames should be transferred (implies pre-HEADERS data).
        //
        // Let's go with the HTTP/3 behavior.
        // There are also clients that send payload along with CONNECT to save milliseconds apparently.
        // Beware of upstream proxy servers that send out valid CONNECT responses with diagnostic data such as IPs!
        sourceSocket.unshift(head);
    }
    const url = new node_url_1.URL(`connect://${request.url}`);
    const destination = {
        port: Number(url.port),
        host: url.hostname,
    };
    let targetSocket;
    try {
        const client = await socks_1.SocksClient.createConnection({
            proxy,
            command: 'connect',
            destination,
        });
        targetSocket = client.socket;
        sourceSocket.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
    }
    catch (error) {
        const socksError = error;
        server.log(proxyChainId, `Failed to connect to upstream SOCKS proxy ${socksError.stack}`);
        sourceSocket.end((0, statuses_1.createCustomStatusHttpResponse)((0, statuses_1.socksErrorMessageToStatusCode)(socksError.message), socksError.message));
        return;
    }
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
    targetSocket.on('error', (error) => {
        server.log(proxyChainId, `Chain SOCKS Destination Socket Error: ${error.stack}`);
        sourceSocket.destroy();
    });
    sourceSocket.on('error', (error) => {
        server.log(proxyChainId, `Chain SOCKS Source Socket Error: ${error.stack}`);
        targetSocket.destroy();
    });
};
exports.chainSocks = chainSocks;
//# sourceMappingURL=chain_socks.js.map