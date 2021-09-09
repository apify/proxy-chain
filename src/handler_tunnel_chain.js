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
                ...this.proxyHeaders,
                Host: targetHost,
            },
        };

        maybeAddProxyAuthorizationHeader(this.upstreamProxyUrlParsed, options.headers);

        this.trgRequest = http.request(options);

        this.trgRequest.on('socket', this.onTrgSocket);
        this.trgRequest.on('connect', this.onTrgRequestConnect);
        this.trgRequest.on('abort', this.onTrgRequestAbort);
        this.trgRequest.on('error', this.onTrgRequestError);

        // Send the data
        this.trgRequest.end();
    }

    onTrgRequestConnect(response, socket, head) {
        if (this.isClosed) return;
        this.log('Connected to upstream proxy');

        // Attempt to fix https://github.com/apify/proxy-chain/issues/64,
        // perhaps the 'connect' event might occur before 'socket'
        if (!this.trgSocket) {
            this.onTrgSocket(socket);
        }

        if (this.checkUpstreamProxy407(response)) return;

        this.srcGotResponse = true;
        this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
        this.srcResponse.writeHead(200, 'Connection Established');

        this.emit('tunnelConnectResponded', { response, socket, head });

        // HACK: force a flush of the HTTP header. This is to ensure 'head' is empty to avoid
        // assert at https://github.com/request/tunnel-agent/blob/master/index.js#L160
        // See also https://github.com/nodejs/node/blob/master/lib/_http_outgoing.js#L217
        this.srcResponse._send('');

        // It can happen that this.close() it called in the meanwhile, so this.srcSocket becomes null
        // and the detachSocket() call below fails with "Cannot read property '_httpMessage' of null"
        // See https://github.com/apify/proxy-chain/issues/63
        if (this.isClosed) return;

        // Relinquish control of the `socket` from the ServerResponse instance
        this.srcResponse.detachSocket(this.srcSocket);

        // Nullify the ServerResponse object, so that it can be cleaned
        // up before this socket proxying is completed
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
