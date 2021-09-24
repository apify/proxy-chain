const http = require('http');
const { Buffer } = require('buffer');
const { countTargetBytes } = require('./utils/count_target_bytes');
const { getBasic } = require('./utils/get_basic');

const createHttpResponse = (statusCode, message) => {
    return [
        `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] || 'Unknown Status Code'}`,
        'Connection: close',
        `Date: ${(new Date()).toUTCString()}`,
        `Content-Length: ${Buffer.byteLength(message)}`,
        ``,
        message,
    ].join('\r\n');
};

/**
 * @typedef Options
 *
 * @property {ClientRequest} request
 * @property {net.Socket} sourceSocket - a stream where to pipe from
 * @property {Buffer} head - optional, the response buffer attached to CONNECT request
 * @property {*} handlerOpts - handler options that contain upstreamProxyUrlParsed
 * @property {http.Server} server - the server that we will use for logging
 * @property {boolean} isPlain - whether to send HTTP CONNECT response
 */

/**
 * @param {Options} options
 */
const chain = ({ request, sourceSocket, head, handlerOpts, server, isPlain }) => {
    if (head && head.length > 0) {
        throw new Error(`Unexpected data on CONNECT: ${head.length} bytes`);
    }

    const { proxyChainId } = sourceSocket;

    const { upstreamProxyUrlParsed: proxy } = handlerOpts;

    const options = {
        method: 'CONNECT',
        path: request.url,
        headers: [
            'host',
            request.url,
        ],
    };

    if (proxy.username || proxy.password) {
        options.headers.push('proxy-authorization', getBasic(proxy));
    }

    const client = http.request(proxy.origin, options);

    client.on('connect', (response, targetSocket, clientHead) => {
        countTargetBytes(sourceSocket, targetSocket);

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
            } else {
                sourceSocket.end(createHttpResponse(502, ''));
            }

            return;
        }

        if (clientHead.length > 0) {
            targetSocket.destroy(new Error(`Unexpected data on CONNECT: ${clientHead.length} bytes`));
            return;
        }

        server.emit('tunnelConnectResponded', {
            response,
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
        server.log(proxyChainId, `Failed to connect to upstream proxy: ${error.stack}`);

        // The end socket may get connected after the client to proxy one gets disconnected.
        if (sourceSocket.readyState === 'open') {
            if (isPlain) {
                sourceSocket.end();
            } else {
                sourceSocket.end(createHttpResponse(502, ''));
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

module.exports.chain = chain;
