import http from 'http';
import HandlerBase from './handler_base';
import { maybeAddProxyAuthorizationHeader } from './tools';

/**
 * Represents a connection from source client to an external proxy using HTTP CONNECT tunnel.
 */
export default class HandlerTunnelChain extends HandlerBase {
    constructor(options) {
        super(options);

        if (!this.upstreamProxyUrlParsed) throw new Error('The "upstreamProxyUrlParsed" option is required');

        this.bindHandlersToThis(['onTrgRequestConnect', 'onTrgRequestAbort', 'onTrgRequestError']);
    }

    run() {
        this.log('Connecting to upstream proxy...');

        const targetHost = `${this.trgParsed.hostname}:${this.trgParsed.port}`;

        const options = {
            method: 'CONNECT',
            hostname: this.upstreamProxyUrlParsed.hostname,
            port: this.upstreamProxyUrlParsed.port,
            path: targetHost,
            headers: {
                Host: targetHost,
            },
        };

        maybeAddProxyAuthorizationHeader(this.upstreamProxyUrlParsed, options.headers);

        this.trgRequest = http.request(options);

        this.trgRequest.once('connect', this.onTrgRequestConnect);
        this.trgRequest.once('abort', this.onTrgRequestAbort);
        this.trgRequest.once('error', this.onTrgRequestError);
        this.trgRequest.on('socket', this.onTrgSocket);

        // Send the data
        this.trgRequest.end();
    }

    onTrgRequestConnect(response, socket, head) {
        if (this.isClosed) return;
        this.log('Connected to upstream proxy');

        if (this.checkUpstreamProxy407(response)) return;

        this.srcGotResponse = true;
        this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
        this.srcResponse.writeHead(200, 'Connection Established');

        // HACK: force a flush of the HTTP header. This is to ensure 'head' is empty to avoid
        // assert at https://github.com/request/tunnel-agent/blob/master/index.js#L160
        // See also https://github.com/nodejs/node/blob/master/lib/_http_outgoing.js#L217
        this.srcResponse._send('');

        // relinquish control of the `socket` from the ServerResponse instance
        this.srcResponse.detachSocket(this.srcSocket);

        // nullify the ServerResponse object, so that it can be cleaned
        // up before this socket proxying is completed
        this.srcResponse = null;

        // Forward pre-parsed parts of the first packets (if any)
        if (head && head.length > 0) {
            this.srcSocket.write(head);
        }
        if (this.srcHead && this.srcHead.length > 0) {
            this.trgSocket.write(this.srcHead);
        }

        // Setup bi-directional tunnel
        this.trgSocket.pipe(this.srcSocket);
        this.srcSocket.pipe(this.trgSocket);
    }

    onTrgRequestAbort() {
        if (this.isClosed) return;
        this.log('Target aborted');
        this.close();
    }

    onTrgRequestError(err) {
        if (this.isClosed) return;
        this.log(`Target request failed: ${err.stack || err}`);
        this.fail(err);
    }
}
