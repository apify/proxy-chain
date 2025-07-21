"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forwardSocks = void 0;
const tslib_1 = require("tslib");
const node_http_1 = tslib_1.__importDefault(require("node:http"));
const node_stream_1 = tslib_1.__importDefault(require("node:stream"));
const node_util_1 = tslib_1.__importDefault(require("node:util"));
const socks_proxy_agent_1 = require("socks-proxy-agent");
const statuses_1 = require("./statuses");
const count_target_bytes_1 = require("./utils/count_target_bytes");
const valid_headers_only_1 = require("./utils/valid_headers_only");
const pipeline = node_util_1.default.promisify(node_stream_1.default.pipeline);
/**
 * ```
 * Client -> Apify (HTTP) -> Upstream (SOCKS) -> Web
 * Client <- Apify (HTTP) <- Upstream (SOCKS) <- Web
 * ```
 */
const forwardSocks = async (request, response, handlerOpts) => new Promise(async (resolve, reject) => {
    const agent = new socks_proxy_agent_1.SocksProxyAgent(handlerOpts.upstreamProxyUrlParsed);
    const options = {
        method: request.method,
        headers: (0, valid_headers_only_1.validHeadersOnly)(request.rawHeaders),
        insecureHTTPParser: true,
        localAddress: handlerOpts.localAddress,
        agent,
    };
    // Only handling "http" here - since everything else is handeled by tunnelSocks.
    // We have to force cast `options` because @types/node doesn't support an array.
    const client = node_http_1.default.request(request.url, options, async (clientResponse) => {
        try {
            // This is necessary to prevent Node.js throwing an error
            let statusCode = clientResponse.statusCode;
            if (statusCode < 100 || statusCode > 999) {
                statusCode = statuses_1.badGatewayStatusCodes.STATUS_CODE_OUT_OF_RANGE;
            }
            // 407 is handled separately
            if (clientResponse.statusCode === 407) {
                reject(new Error('407 Proxy Authentication Required'));
                return;
            }
            response.writeHead(statusCode, clientResponse.statusMessage, (0, valid_headers_only_1.validHeadersOnly)(clientResponse.rawHeaders));
            // `pipeline` automatically handles all the events and data
            await pipeline(clientResponse, response);
            resolve();
        }
        catch {
            // Client error, pipeline already destroys the streams, ignore.
            resolve();
        }
    });
    client.once('socket', (socket) => {
        (0, count_target_bytes_1.countTargetBytes)(request.socket, socket);
    });
    // Can't use pipeline here as it automatically destroys the streams
    request.pipe(client);
    client.on('error', (error) => {
        var _a;
        if (response.headersSent) {
            return;
        }
        const statusCode = (_a = statuses_1.errorCodeToStatusCode[error.code]) !== null && _a !== void 0 ? _a : statuses_1.badGatewayStatusCodes.GENERIC_ERROR;
        response.statusCode = statusCode;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end(node_http_1.default.STATUS_CODES[response.statusCode]);
        resolve();
    });
});
exports.forwardSocks = forwardSocks;
//# sourceMappingURL=forward_socks.js.map