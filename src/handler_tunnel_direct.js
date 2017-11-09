import net from 'net';
import HandlerBase from './handler_base';


/**
 * Represents a proxied connection from source to the target HTTPS server.
 */
export default class HandlerTunnelDirect extends HandlerBase {
    constructor(options) {
        super(options);

        if (!this.trgHost || !this.trgPort) throw new Error('The "trgHost" and "trgPort" options are required');

        this.bindHandlersToThis(['onTrgSocketConnect', 'onTrgSocketClose', 'onTrgSocketEnd', 'onTrgSocketError']);
    }

    log(str) {
        if (this.verbose) console.log(`HandlerTunnelDirect[${this.trgHost}:${this.trgPort}]: ${str}`);
    }

    run() {
        this.log('Connecting...');

        this.trgSocket = net.createConnection(this.trgPort, this.trgHost);
        this.trgSocket.once('connect', this.onTrgSocketConnect);
        this.trgSocket.once('close', this.onTrgSocketClose);
        this.trgSocket.once('end', this.onTrgSocketEnd);
        this.trgSocket.once('error', this.onTrgSocketError);
    }

    onTrgSocketConnect () {
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

        this.srcSocket.resume();

        // Setup bi-directional tunnel
        this.trgSocket.pipe(this.srcSocket);
        this.srcSocket.pipe(this.trgSocket);

        //this.trgSocket.pipe(tee('to src')).pipe(this.srcSocket);
        //this.srcSocket.pipe(tee('to trg')).pipe(this.trgSocket);
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
        super.handleTargetError(err);
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
