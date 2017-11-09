import http from 'http';
import net from 'net';
import _ from 'underscore';
import { tee } from './tools';
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
        this.log('Connecting to target...');
        this.trgSocket = net.createConnection(this.trgPort, this.trgHost);
        this.trgSocket.on('connect', this.onTrgSocketConnect);
        this.trgSocket.on('close', this.onTrgSocketClose);
        this.trgSocket.on('end', this.onTrgSocketEnd);
        this.trgSocket.on('error', this.onTrgSocketError);
    }

    onTrgSocketConnect () {
        this.log('Connected to target');

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
        //this.trgSocket.pipe(this.srcSocket);
        //this.srcSocket.pipe(this.trgSocket);

        this.trgSocket.pipe(tee('to src')).pipe(this.srcSocket);
        this.srcSocket.pipe(tee('to trg')).pipe(this.trgSocket);
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

    destroy() {
        if (!super.destroy()) {
            if (this.trgSocket) {
                this.trgSocket.destroy();
                this.trgSocket = null;
            }
            return true;
        }
        return false;
    }
}



/**
 * Represents a proxied connection from source to the target HTTPS server.
 */
class HandlerTunnelDirectOld {

    constructor({ srcRequest, srcSocket, trgHost, trgPort, verbose }) {
        this.srcRequest = srcRequest;
        this.srcSocket = srcSocket;
        this.verbose = verbose;

        // Indicates that source connection might have received some data already
        this.srcGotResponse = false;

        this.trgHost = trgHost;
        this.trgPort = trgPort;
        this.trgSocket = null;

        // Bind all event handlers to 'this'
        ['onSrcClose', 'onSrcEnd', 'onSrcError', 'onTrgConnect', 'onTrgClose', 'onTrgEnd',
         'onTrgError', 'onSrcResponseFinish'].forEach((evt) => {
            this[evt] = this[evt].bind(this);
        });

        this.srcSocket.on('close', this.onSrcClose);
        this.srcSocket.on('end', this.onSrcEnd);
        this.srcSocket.on('error', this.onSrcError);

        // Create ServerResponse for the client request, since Node.js doesn't create one
        // NOTE: This is undocummented API, it might break in the future
        this.srcResponse = new http.ServerResponse(srcRequest);
        this.srcResponse.shouldKeepAlive = false;
        this.srcResponse.chunkedEncoding = false;
        this.srcResponse.useChunkedEncodingByDefault = false;
        this.srcResponse.assignSocket(srcSocket);

        // called for the ServerResponse's "finish" event
        // XXX: normally, node's "http" module has a "finish" event listener that would
        // take care of closing the socket once the HTTP response has completed, but
        // since we're making this ServerResponse instance manually, that event handler
        // never gets hooked up, so we must manually close the socket...
        this.srcResponse.once('finish', this.onSrcResponseFinish);

        // TODO: pause the socket during authentication so no data is lost
        this.srcSocket.pause();
    }

    log(str) {
        if (this.verbose) console.log(`HandlerTunnelDirect[${this.trgHost}:${this.trgPort}]: ${str}`);
    }

    run() {
        this.log('Connecting to target...');
        this.trgSocket = net.createConnection(this.trgPort, this.trgHost);
        this.trgSocket.on('connect', this.onTrgConnect);
        this.trgSocket.on('close', this.onTrgClose);
        this.trgSocket.on('end', this.onTrgEnd);
        this.trgSocket.on('error', this.onTrgError);
    }

    onSrcResponseFinish() {
        this.log('Source response finished');
        this.srcResponse.detachSocket(socket);
        this.srcSocket.end();
    }

    onSrcClose() {
        this.log(`Source socket closed`);
    }

    onSrcEnd() {
        this.log(`Source socket ended`);
        this.removeListeners();
    }

    onSrcError(err) {
        this.log(`Source socket failed: ${err.stack || err}`);
    }

    onTrgConnect () {
        this.log('Target connected');

        this.srcGotResponse = true;
        this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
        this.srcResponse.writeHead(200, 'Connection established');

        // HACK: force a flush of the HTTP header
        this.srcResponse._send('');

        // relinquish control of the `socket` from the ServerResponse instance
        this.srcResponse.detachSocket(this.srcSocket);

        // nullify the ServerResponse object, so that it can be cleaned
        // up before this socket proxying is completed
        this.srcResponse = null;

        this.srcSocket.resume();

        // Setup bi-directional tunnel
        //this.trgSocket.pipe(this.srcSocket);
        //this.srcSocket.pipe(this.trgSocket);

        this.trgSocket.pipe(tee('to src')).pipe(this.srcSocket);
        this.srcSocket.pipe(tee('to trg')).pipe(this.trgSocket);
    }

    /**
     * Target closed the connection.
     * @private
     */
    onTrgClose() {
        this.log('Target connection closed');
        this.removeListeners();
        this.srcSocket.destroy();
    }

    onTrgEnd() {
        this.log('Target connection ended');
        this.removeListeners();
    }

    onTrgError(err) {
        this.log(`Target connection failed: ${err.stack || err}`);

        this.removeListeners();

        if (this.srcGotResponse) {
            this.log('already sent a response, just destroying the socket...');
            this.srcSocket.destroy();
        } else if (err.code === 'ENOTFOUND') {
            this.log('Target not found, sending 404 to source');
            this.srcResponse.writeHead(404);
            this.srcResponse.end();
        } else {
            this.log('Unknown error, sending 500 to source');
            this.srcResponse.writeHead(500);
            this.srcResponse.end();
        }
    }

    /**
     * Detaches all listeners from all both source and target sockets.
     */
    removeListeners () {
        this.log('Detaching listeners');

        this.srcSocket.removeListener('close', this.onSrcClose);
        this.srcSocket.removeListener('error', this.onSrcError);
        this.srcSocket.removeListener('end', this.onSrcEnd);

        if (this.trgSocket) {
            this.trgSocket.removeListener('connect', this.onTrgConnect);
            this.trgSocket.removeListener('close', this.onTrgClose);
            this.trgSocket.removeListener('end', this.onTrgEnd);
            this.trgSocket.removeListener('error', this.onTrgError);
        }
    }

}