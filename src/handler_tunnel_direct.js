import net from 'net';
import HandlerBase from './handler_base';

/**
 * Represents a proxied connection from source to the target HTTPS server.
 */
export default class HandlerTunnelDirect extends HandlerBase {
    constructor(options) {
        super(options);

        this.bindHandlersToThis(['onTrgSocketConnect', 'onTrgSocketClose', 'onTrgSocketEnd', 'onTrgSocketError']);
    }

    log(str) {
        if (this.verbose) console.log(`HandlerTunnelDirect[${this.trgParsed.hostname}:${this.trgParsed.port}]: ${str}`);
    }

    run() {
        this.log('Connecting to target...');

        this.trgSocket = net.createConnection(this.trgParsed.port, this.trgParsed.hostname);
        this.trgSocket.once('connect', this.onTrgSocketConnect);
        this.trgSocket.once('close', this.onTrgSocketClose);
        this.trgSocket.once('end', this.onTrgSocketEnd);
        this.trgSocket.once('error', this.onTrgSocketError);
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

    onTrgSocketClose() {
        this.log('Target socket closed');
        this.removeListeners();
        this.srcSocket.destroy();
    }

    onTrgSocketEnd() {
        this.log('Target socket ended');
        this.removeListeners();
    }

    onTrgSocketError(err) {
        this.log(`Target socket failed: ${err.stack || err}`);
        super.fail(err);
    }

    removeListeners() {
        super.removeListeners();

        if (this.trgSocket) {
            this.trgSocket.removeListener('connect', this.onTrgSocketConnect);
            this.trgSocket.removeListener('close', this.onTrgSocketClose);
            this.trgSocket.removeListener('end', this.onTrgSocketEnd);
            this.trgSocket.removeListener('error', this.onTrgSocketError);
        }
    }
}
