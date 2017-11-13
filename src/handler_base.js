import http from 'http';
import EventEmitter from 'events';
import { parseUrl, redactParsedUrl } from './tools';

/* globals Buffer */

/**
 * Base class for proxy connection handlers. It emits the `destroyed` event
 * when the handler is no longer used.
 */
export default class HandlerBase extends EventEmitter {
    constructor({ id, srcRequest, srcResponse, trgParsed, verbose, upstreamProxyUrl }) {
        super();

        if (!id) throw new Error('The "id" option is required');
        if (!srcRequest) throw new Error('The "srcRequest" option is required');
        if (!trgParsed.hostname) throw new Error('The "trgParsed.hostname" option is required');

        this.id = id;

        this.srcRequest = srcRequest;
        this.srcResponse = srcResponse;
        this.srcSocket = srcRequest.socket;

        this.trgRequest = null;
        this.trgSocket = null;
        this.trgParsed = trgParsed;
        this.trgParsed.port = this.trgParsed.port || DEFAULT_TARGET_PORT;

        this.verbose = !!verbose;
        this.upstreamProxyUrl = upstreamProxyUrl;

        this.upstreamProxyUrlParsed = upstreamProxyUrl ? parseUrl(upstreamProxyUrl) : null;
        this.upstreamProxyUrlRedacted = upstreamProxyUrl ? redactParsedUrl(this.upstreamProxyUrlParsed) : null;

        // Indicates that source socket might have received some data already
        this.srcGotResponse = false;

        this.isDestroyed = false;

        if (upstreamProxyUrl) {
            if (!this.upstreamProxyUrlParsed.hostname || !this.upstreamProxyUrlParsed.port) {
                throw new Error('Invalid "upstreamProxyUrl" option: URL must have hostname and port');
            }
            if (this.upstreamProxyUrlParsed.scheme !== 'http') {
                throw new Error('Invalid "upstreamProxyUrl" option: URL must have the "http" scheme');
            }
        }

        // Create ServerResponse for the client HTTP request if it doesn't exist
        // NOTE: This is undocummented API, it might break in the future
        if (!this.srcResponse) {
            this.srcResponse = new http.ServerResponse(srcRequest);
            this.srcResponse.shouldKeepAlive = false;
            this.srcResponse.chunkedEncoding = false;
            this.srcResponse.useChunkedEncodingByDefault = false;
            this.srcResponse.assignSocket(this.srcSocket);
        }

        // Bind all event handlers to this instance
        this.bindHandlersToThis(['onSrcResponseFinish', 'onSrcSocketClose', 'onSrcSocketEnd', 'onSrcSocketError']);

        // called for the ServerResponse's "finish" event
        // XXX: normally, node's "http" module has a "finish" event listener that would
        // take care of closing the socket once the HTTP response has completed, but
        // since we're making this ServerResponse instance manually, that event handler
        // never gets hooked up, so we must manually close the socket...
        this.srcResponse.once('finish', this.onSrcResponseFinish);

        this.srcSocket.once('close', this.onSrcSocketClose);
        this.srcSocket.once('end', this.onSrcSocketEnd);
        this.srcSocket.once('error', this.onSrcSocketError);
    }

    bindHandlersToThis(handlerNames) {
        handlerNames.forEach((evt) => {
            this[evt] = this[evt].bind(this);
        });
    }

    // Abstract method, needs to be overridden
    log() {}

    // Abstract method, needs to be overridden
    run() {}

    // if the client closes the connection prematurely,
    // then close the upstream socket
    onSrcSocketClose() {
        this.log('Source socket closed');
        this.destroy();
    }

    onSrcSocketEnd() {
        this.log(`Source socket ended`);
        this.destroy();
    }

    onSrcSocketError(err) {
        this.log(`Source socket failed: ${err.stack || err}`);
        this.destroy();
    }

    onSrcResponseFinish () {
        this.log('Source response finished');
        this.removeListeners();
    }

    maybeAddProxyAuthorizationHeader(headers) {
        const parsed = this.upstreamProxyUrlParsed;
        if (parsed && parsed.username) {
            let auth = parsed.username;
            if (parsed.password) auth += ':' + parsed.password;
            headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
        }
    }

    fail(err, statusCode) {
        this.removeListeners();

        if (this.srcGotResponse) {
            this.log('Source already received a response, just destroying the socket...');
            this.destroy();
        } else if (statusCode) {
            // Custom error message coming from RequestError
            this.log(`${err}, responding with custom status code ${statusCode} to client`);
            this.srcResponse.writeHead(statusCode);
            this.srcResponse.end(`${err}`);
        } else if (err.code === 'ENOTFOUND' && this.upstreamProxyUrl) {
            this.log('Upstream proxy not found, sending 502 to client');
            this.srcResponse.writeHead(502);
            this.srcResponse.end('Upstream proxy was not found');
        } else if (err.code === 'ENOTFOUND' && !this.upstreamProxyUrl) {
            this.log('Target server not found, sending 404 to client');
            this.srcResponse.writeHead(404);
            this.srcResponse.end('Target server not found');
        } else {
            this.log('Unknown error, sending 500 to client');
            this.srcResponse.writeHead(500);
            this.srcResponse.end('Internal server error');
        }
    };

    removeListeners() {
        this.log('Removing listeners');

        if (this.srcSocket) {
            this.srcSocket.removeListener('close', this.onSrcSocketClose);
            this.srcSocket.removeListener('end', this.onSrcSocketEnd);
            this.srcSocket.removeListener('error', this.onSrcSocketError);
        }
        if (this.srcResponse) {
            this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
        }
    }

    /**
     * Detaches all listeners and destroys all sockets.
     */
    destroy() {
        if (!this.isDestroyed) {
            this.log('Destroying');
            this.removeListeners();

            if (this.srcRequest) {
                this.srcRequest.destroy();
                this.srcRequest = null;
            }

            if (this.srcSocket) {
                this.srcSocket.destroy();
                this.srcSocket = null;
            }

            if (this.trgRequest) {
                this.trgRequest.abort();
                this.trgRequest = null;
            }

            if (this.trgSocket) {
                this.trgSocket.destroy();
                this.trgSocket = null;
            }

            this.isDestroyed = true;

            this.emit('destroy');
        }
    }
}