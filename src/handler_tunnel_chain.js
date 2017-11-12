import http from 'http';
import { tee } from './tools';
import HandlerBase from './handler_base';

/* globals Buffer */

/**
 * Represents a connection from source client to an external proxy using HTTP CONNECT tunnel.
 */
export default class HandlerTunnelChain extends HandlerBase {
    constructor(options) {
        super(options);

        if (!this.chainedProxyUrl) throw new Error('The "chainedProxyUrl" option is required');

        this.bindHandlersToThis(['onTrgRequestConnect', 'onTrgRequestAbort', 'onTrgRequestError']);
    }

    log(str) {
        if (this.verbose) console.log(`HandlerTunnelChain[${this.chainedProxyUrlRedacted} -> ${this.trgParsed.hostname}:${this.trgParsed.port}]: ${str}`);
    }

    run() {
        this.log('Connecting to proxy...');

        let options = {
            method: 'CONNECT',
            hostname: this.chainedProxyUrlParsed.hostname,
            port: this.chainedProxyUrlParsed.port,
            path: `${this.trgParsed.hostname}:${this.trgParsed.port}`,
            headers: {},
        };

        this.maybeAddProxyAuthorizationHeader(options.headers);

        this.trgRequest = http.request(options);

        this.trgRequest.once('connect', this.onTrgRequestConnect);
        this.trgRequest.once('abort', this.onTrgRequestAbort);
        this.trgRequest.once('error', this.onTrgRequestError);

        // TODO: remove these...
        this.trgRequest.on('continue', () => {
            this.log('Target continue');
        });
        this.trgRequest.on('socket', () => {
            this.log('Target socket');
        });
        this.trgRequest.on('timeout', () => {
            this.log('Target timeout');
        });

        // Send the data
        this.trgRequest.end();
    }

    onTrgRequestConnect (response, socket, head) {
        this.log(`Connected to target proxy`);

        this.srcGotResponse = true;
        this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
        this.srcResponse.writeHead(200, 'Connection established');

        // TODO: ???
        //this.response.writeHead(response.statusCode, response.statusMessage);

        // TODO: attach handlers to trgSocket ???
        this.trgSocket = socket;

        // HACK: force a flush of the HTTP header
        this.srcResponse._send('');

        // relinquish control of the `socket` from the ServerResponse instance
        this.srcResponse.detachSocket(this.srcSocket);

        // nullify the ServerResponse object, so that it can be cleaned
        // up before this socket proxying is completed
        this.srcResponse = null;

        // Setup bi-directional tunnel
        this.trgSocket.pipe(this.srcSocket);
        this.srcSocket.pipe(this.trgSocket);
        //this.trgSocket.pipe(tee('to src')).pipe(this.srcSocket);
        //this.srcSocket.pipe(tee('to trg')).pipe(this.trgSocket);
    }

    onTrgRequestAbort() {
        this.log('Target aborted');
        this.destroy();
    }

    onTrgRequestError(err) {
        this.log(`Target request failed: ${err.stack || err}`);
        this.fail(err);
    }

    removeListeners() {
        super.removeListeners();

        if (this.trgRequest) {
            this.trgRequest.removeListener('connect', this.onTrgRequestConnect);
            this.trgRequest.removeListener('close', this.onTrgRequestAbort);
            this.trgRequest.removeListener('end', this.onTrgRequestError);
        }
    }
}
