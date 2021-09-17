const net = require('net');

/**
 * @typedef Options
 *
 * @property {ClientRequest} request
 * @property {net.Socket} source - a stream where to pipe from
 * @property {Buffer} head - optional, the response buffer attached to CONNECT request
 * @property {*} handlerOpts - handler options that contain upstreamProxyUrlParsed
 * @property {http.Server} server - the server that we will use for logging
 * @property {boolean} isPlain - whether to send HTTP CONNECT response
 */

/**
 * @param {Options} options
 */
const direct = ({ request, source, head, server }) => {
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

    const socket = net.createConnection(options, () => {
        try {
            source.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
        } catch (error) {
            source.destroy(error);
        }
    });

    source.pipe(socket);
    socket.pipe(source);

    socket.on('error', (error) => {
        server.log(null, `Direct Destination Socket Error: ${error.stack}`);

        source.destroy();
    });

    source.on('error', (error) => {
        server.log(null, `Direct Source Socket Error: ${error.stack}`);

        socket.destroy();
    });
};

module.exports.direct = direct;
