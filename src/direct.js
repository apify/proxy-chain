const net = require('net');

/**
 * @param {http.ClientRequest} request
 * @param {net.Socket} source
 * @param {buffer.Buffer} head
 */
const direct = (request, source, head) => {
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

    const socket = net.createConnection(url.port, url.hostname, () => {
        source.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);
    });

    source.pipe(socket);
    socket.pipe(source);

    socket.on('error', () => {
        source.destroy();
    });

    source.on('error', () => {
        socket.destroy();
    });
};

module.exports.direct = direct;
