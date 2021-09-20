const http = require('http');
const { countTargetBytes } = require('./utils/count_target_bytes');
const { getBasic } = require('./utils/get_basic');

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
const chain = ({ request, source, head, handlerOpts, server, isPlain }) => {
    if (head && head.length > 0) {
        throw new Error(`Unexpected data on CONNECT: ${head.length} bytes`);
    }

    const { proxyChainId } = source;

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

    client.on('connect', (response, socket, clientHead) => {
        countTargetBytes(source, socket);

        if (source.readyState !== 'open') {
            // Sanity check, should never reach.
            socket.destroy();
            return;
        }

        socket.on('error', (error) => {
            server.log(proxyChainId, `Chain Destination Socket Error: ${error.stack}`);

            source.destroy();
        });

        source.on('error', (error) => {
            server.log(proxyChainId, `Chain Source Socket Error: ${error.stack}`);

            socket.destroy();
        });

        if (response.statusCode !== 200) {
            server.log(proxyChainId, `Failed to authenticate upstream proxy: ${response.statusCode}`);

            source.end(isPlain ? '' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
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

        source.write(isPlain ? '' : `HTTP/1.1 200 Connection Established\r\n\r\n`);

        source.pipe(socket);
        socket.pipe(source);
    });

    client.on('error', (error) => {
        server.log(proxyChainId, `Failed to connect to upstream proxy: ${error.stack}`);

        // The end socket may get connected after the client to proxy one gets disconnected.
        if (source.readyState === 'open') {
            source.end(isPlain ? '' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
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
