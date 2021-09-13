const http = require('http');

/**
 * @param {http.ClientRequest} request
 * @param {net.Socket} source
 * @param {buffer.Buffer} head
 * @param {*} handlerOpts
 * @param {*} server
 */
const chain = (request, source, head, handlerOpts, server) => {
    if (head.length > 0) {
        throw new Error(`Unexpected data on CONNECT: ${head.length} bytes`);
    }

    const { upstreamProxyUrlParsed: proxy } = handlerOpts;

    const options = {
        method: 'CONNECT',
        hostname: proxy.hostname,
        port: proxy.port,
        path: request.url,
        headers: [
            'host',
            request.url,
        ],
    };

    if (proxy.username || proxy.password) {
        const auth = `${proxy.username}:${proxy.password}`;

        options.headers.push('proxy-authorization', `Basic ${Buffer.from(auth).toString('base64')}`);
    }

    const client = http.request(options);

    client.on('connect', (response, socket, clientHead) => {
        if (source.readyState !== 'open') {
            // Sanity check, should never reach.
            socket.destroy();
            return;
        }

        socket.on('error', (error) => {
            server.log(null, `Chain Socket Error: ${error.stack}`);

            source.destroy();
        });

        if (response.statusCode !== 200) {
            server.log(null, `Failed to authenticate upstream proxy: ${response.statusCode}`);

            source.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            return;
        }

        if (clientHead.length > 0) {
            socket.destroy(new Error(`Unexpected data on CONNECT: ${clientHead.length} bytes`));
            return;
        }

        server.emit('tunnelConnectResponded', {
            response,
            socket,
            head: clientHead,
        });

        source.write(`HTTP/1.1 200 Connection Established\r\n\r\n`);

        source.pipe(socket);
        socket.pipe(source);

        socket.on('error', () => {
            source.destroy();
        });

        source.on('error', () => {
            socket.destroy();
        });
    });

    client.on('error', (error) => {
        server.log(null, `Failed to connect to upstream proxy: ${error.stack}`);

        source.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });

    source.on('error', () => {
        client.destroy();
    });

    source.on('close', () => {
        client.destroy();
    });

    client.end();
};

module.exports.chain = chain;
