const net = require('net');
const HandlerBase = require('./handler_base');

/**
 * Represents a proxied connection from source to the target HTTPS server.
 */
class HandlerTunnelDirect extends HandlerBase {
    constructor(options) {
        super(options);

        this.bindHandlersToThis(['onTrgSocketConnect']);
    }

    run() {
        this.log(`Connecting to target ${this.trgParsed.hostname}:${this.trgParsed.port}`);

        const socket = net.createConnection(this.trgParsed.port, this.trgParsed.hostname);
        this.onTrgSocket(socket);

        socket.on('connect', this.onTrgSocketConnect);
    }

    onTrgSocketConnect(response, socket, head) {
        if (this.isClosed) return;
        this.log('Connected');

        this.srcGotResponse = true;

        this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
        this.srcResponse.writeHead(200, 'Connection Established');

        // HACK: force a flush of the HTTP header. This is to ensure 'head' is empty to avoid
        // assert at https://github.com/request/tunnel-agent/blob/master/index.js#L160
        // See also https://github.com/nodejs/node/blob/master/lib/_http_outgoing.js#L217
        // eslint-disable-next-line no-underscore-dangle
        this.srcResponse._send('');

        // It can happen that this.close() it called in the meanwhile, so this.srcSocket becomes null
        // and the detachSocket() call below fails with "Cannot read property '_httpMessage' of null"
        // See https://github.com/apify/proxy-chain/issues/63
        if (this.isClosed) return;

        // Relinquish control of the socket from the ServerResponse instance
        this.srcResponse.detachSocket(this.srcSocket);

        // ServerResponse is no longer needed
        this.srcResponse = null;

        // Forward pre-parsed parts of the first packets (if any)
        if (head && head.length > 0) {
            this.srcSocket.write(head);
        }
        if (this.srcHead && this.srcHead.length > 0) {
            this.trgSocket.write(this.srcHead);
        }

        // Note that sockets could be closed anytime, causing this.close() to be called too in above statements
        // See https://github.com/apify/proxy-chain/issues/64
        if (this.isClosed) return;

        // Setup bi-directional tunnel
        this.trgSocket.pipe(this.srcSocket);
        this.srcSocket.pipe(this.trgSocket);
    }
}

module.exports = HandlerTunnelDirect;
