const net = require('net');

/**
 * @param {http.ClientRequest} request
 * @param {net.Socket} source
 * @param {buffer.Buffer} head
 * @param {*} handlerOpts
 * @param {*} server
 */
const direct = (request, source, head, handlerOpts, server) => {
    const url = new URL(`connect://${request.url}`);

    if (!url.port) {
        throw new Error('Missing CONNECT port');
    }

    if (!url.hostname) {
        throw new Error('Missing CONNECT hostname');
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
