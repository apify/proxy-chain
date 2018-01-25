import net from 'net';
import HandlerBase from './handler_base';

/**
 * Represents a proxied connection from source to the target HTTPS server.
 */
export default class HandlerTunnelDirect extends HandlerBase {
    constructor(options) {
        super(options);

        this.bindHandlersToThis(['onTrgSocketConnect']);
    }

    run() {
        this.log(`Connecting to target ${this.trgParsed.hostname}:${this.trgParsed.port}`);

        const socket = net.createConnection(this.trgParsed.port, this.trgParsed.hostname);
        socket.once('connect', this.onTrgSocketConnect);

        this.onTrgSocket(socket);
    }

    onTrgSocketConnect() {
        this.log('Connected');

        this.srcGotResponse = true;

        this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
        this.srcResponse.writeHead(200, 'Connection established');

        // HACK: force a flush of the HTTP header
        this.srcResponse._send('');

        // Relinquish control of the socket from the ServerResponse instance
        this.srcResponse.detachSocket(this.srcSocket);

        // ServerResponse is no longer needed
        this.srcResponse = null;

        // Setup bi-directional tunnel
        this.trgSocket.pipe(this.srcSocket);
        this.srcSocket.pipe(this.trgSocket);
        // this.trgSocket.pipe(tee('to src')).pipe(this.srcSocket);
        // this.srcSocket.pipe(tee('to trg')).pipe(this.trgSocket);
    }

    removeListeners() {
        super.removeListeners();

        if (this.trgSocket) {
            this.trgSocket.removeListener('connect', this.onTrgSocketConnect);
        }
    }
}
