"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chain = void 0;
const tslib_1 = require("tslib");
const node_http_1 = tslib_1.__importDefault(require("node:http"));
const node_https_1 = tslib_1.__importDefault(require("node:https"));
const statuses_1 = require("./statuses");
const count_target_bytes_1 = require("./utils/count_target_bytes");
const get_basic_1 = require("./utils/get_basic");
/**
 * Passes the traffic to upstream HTTP proxy server.
 * Client -> Apify -> Upstream -> Web
 * Client <- Apify <- Upstream <- Web
 */
const chain = ({ request, sourceSocket, head, handlerOpts, server, isPlain, }) => {
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
    const { proxyChainId } = sourceSocket;
    const { upstreamProxyUrlParsed: proxy, customTag } = handlerOpts;
    const options = {
        method: 'CONNECT',
        path: request.url,
        headers: {
            host: request.url,
        },
        localAddress: handlerOpts.localAddress,
        family: handlerOpts.ipFamily,
        lookup: handlerOpts.dnsLookup,
    };
    if (proxy.username || proxy.password) {
        options.headers['proxy-authorization'] = (0, get_basic_1.getBasicAuthorizationHeader)(proxy);
    }
    const client = proxy.protocol === 'https:'
        ? node_https_1.default.request(proxy.origin, {
            ...options,
            rejectUnauthorized: !handlerOpts.ignoreUpstreamProxyCertificate,
        })
        : node_http_1.default.request(proxy.origin, options);
    client.once('socket', (targetSocket) => {
        // Socket can be re-used by multiple requests.
        // That's why we need to track the previous stats.
        targetSocket.previousBytesRead = targetSocket.bytesRead;
        targetSocket.previousBytesWritten = targetSocket.bytesWritten;
        (0, count_target_bytes_1.countTargetBytes)(sourceSocket, targetSocket);
    });
    client.on('connect', (response, targetSocket, clientHead) => {
        if (sourceSocket.readyState !== 'open') {
            // Sanity check, should never reach.
            targetSocket.destroy();
            return;
        }
        targetSocket.on('error', (error) => {
            server.log(proxyChainId, `Chain Destination Socket Error: ${error.stack}`);
            sourceSocket.destroy();
        });
        sourceSocket.on('error', (error) => {
            server.log(proxyChainId, `Chain Source Socket Error: ${error.stack}`);
            targetSocket.destroy();
        });
        if (response.statusCode !== 200) {
            server.log(proxyChainId, `Failed to authenticate upstream proxy: ${response.statusCode}`);
            if (isPlain) {
                sourceSocket.end();
            }
            else {
                const { statusCode } = response;
                const status = statusCode === 401 || statusCode === 407
                    ? statuses_1.badGatewayStatusCodes.AUTH_FAILED
                    : statuses_1.badGatewayStatusCodes.NON_200;
                sourceSocket.end((0, statuses_1.createCustomStatusHttpResponse)(status, `UPSTREAM${statusCode}`));
            }
            targetSocket.end();
            server.emit('tunnelConnectFailed', {
                proxyChainId,
                response,
                customTag,
                socket: targetSocket,
                head: clientHead,
            });
            return;
        }
        if (clientHead.length > 0) {
            // See comment above
            targetSocket.unshift(clientHead);
        }
        server.emit('tunnelConnectResponded', {
            proxyChainId,
            response,
            customTag,
            socket: targetSocket,
            head: clientHead,
        });
        sourceSocket.write(isPlain ? '' : `HTTP/1.1 200 Connection Established\r\n\r\n`);
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
    });
    client.on('error', (error) => {
        var _a, _b;
        server.log(proxyChainId, `Failed to connect to upstream proxy: ${error.stack}`);
        // The end socket may get connected after the client to proxy one gets disconnected.
        if (sourceSocket.readyState === 'open') {
            if (isPlain) {
                sourceSocket.end();
            }
            else {
                const statusCode = (_a = statuses_1.errorCodeToStatusCode[error.code]) !== null && _a !== void 0 ? _a : statuses_1.badGatewayStatusCodes.GENERIC_ERROR;
                const response = (0, statuses_1.createCustomStatusHttpResponse)(statusCode, (_b = error.code) !== null && _b !== void 0 ? _b : 'Upstream Closed Early');
                sourceSocket.end(response);
            }
        }
    });
    sourceSocket.on('error', () => {
        client.destroy();
    });
    // In case the client ends the socket too early
    sourceSocket.on('close', () => {
        client.destroy();
    });
    client.end();
};
exports.chain = chain;
//# sourceMappingURL=chain.js.map