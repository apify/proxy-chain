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
            server.log(null, `Chain Destination Socket Error: ${error.stack}`);

            source.destroy();
        });

        source.on('error', (error) => {
            server.log(null, `Chain Source Socket Error: ${error.stack}`);

            socket.destroy();
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
    });

    client.on('error', (error) => {
        server.log(null, `Failed to connect to upstream proxy: ${error.stack}`);

        // The end socket may get connected after the client to proxy one gets disconnected.
        if (source.readyState === 'open') {
            source.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
    });

    source.on('error', () => {
        client.destroy();
    });

    // In case the client ends the socket too early
    source.on('close', () => {
        client.destroy();
    });

    client.end();
};

module.exports.chain = chain;
