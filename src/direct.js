const net = require('net');
const { countTargetBytes } = require('./utils/count_target_bytes');

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
const direct = ({ request, sourceSocket, head, server }) => {
    const url = new URL(`connect://${request.url}`);

    if (!url.hostname) {
        throw new Error('Missing CONNECT hostname');
    }

    if (!url.port) {
        throw new Error('Missing CONNECT port');
    }

    if (head.length > 0) {
        throw new Error(`Unexpected data on CONNECT: ${head.length} bytes`);
    }

    const options = {
        port: url.port,
        host: url.hostname,
    };

    if (options.host[0] === '[') {
        options.host = options.host.slice(1, -1);
    }

    const targetSocket = net.createConnection(options, () => {
        try {
            sourceSocket.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
        } catch (error) {
            sourceSocket.destroy(error);
        }
    });

    countTargetBytes(sourceSocket, targetSocket);

    sourceSocket.pipe(targetSocket);
    targetSocket.pipe(sourceSocket);

    // Once target socket closes forcibly, the source socket gets paused.
    // We need to enable flowing, otherwise the socket would remain open indefinitely.
    // Nothing would consume the data, we just want to close the socket.
    targetSocket.on('close', () => {
        sourceSocket.resume();

        if (sourceSocket.writable && !sourceSocket.writableEnded) {
            sourceSocket.end();
        }
    });

    // Same here.
    sourceSocket.on('close', () => {
        targetSocket.resume();

        if (targetSocket.writable && !sourceSocket.writableEnded) {
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

module.exports.direct = direct;
