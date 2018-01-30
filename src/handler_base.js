import http from 'http';
import EventEmitter from 'events';

/* globals Buffer */

/**
 * Base class for proxy connection handlers. It emits the `destroyed` event
 * when the handler is no longer used.
 */
export default class HandlerBase extends EventEmitter {
    constructor({
        server, id, srcRequest, srcResponse, trgParsed, upstreamProxyUrlParsed,
    }) {
        super();

        if (!server) throw new Error('The "server" option is required');
        if (!id) throw new Error('The "id" option is required');
        if (!srcRequest) throw new Error('The "srcRequest" option is required');
        if (!trgParsed.hostname) throw new Error('The "trgParsed.hostname" option is required');

        this.server = server;
        this.id = id;

        this.srcRequest = srcRequest;
        this.srcResponse = srcResponse;
        this.srcSocket = srcRequest.socket;

        this.trgRequest = null;
        this.trgSocket = null;
        this.trgParsed = trgParsed;
        this.trgParsed.port = this.trgParsed.port || DEFAULT_TARGET_PORT;

        // Indicates that source socket might have received some data already
        this.srcGotResponse = false;

        this.isClosed = false;

        this.upstreamProxyUrlParsed = upstreamProxyUrlParsed;

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
        this.bindHandlersToThis([
            'onSrcResponseFinish', 'onSrcSocketClose', 'onSrcSocketEnd', 'onSrcSocketError',
            'onTrgSocket', 'onTrgSocketClose', 'onTrgSocketEnd', 'onTrgSocketError',
        ]);

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

    log(str) {
        this.server.log(this.id, str);
    }

    // Abstract method, needs to be overridden
    run() {} // eslint-disable-line

    // If the client closes the connection prematurely,
    // then immediately destroy the upstream socket, there's nothing we can do with it
    onSrcSocketClose() {
        if (this.isClosed) return;
        this.log('Source socket closed');
        this.close();
    }

    onSrcSocketEnd() {
        if (this.isClosed) return;
        this.log('Source socket ended');
        this.close();
    }

    onSrcSocketError(err) {
        if (this.isClosed) return;
        this.log(`Source socket failed: ${err.stack || err}`);
        this.close();
    }

    onSrcResponseFinish() {
        if (this.isClosed) return;
        this.log('Source response finished');
        this.close();
    }

    onTrgSocket(socket) {
        if (this.isClosed) return;
        this.log('Target socket assigned');

        this.trgSocket = socket;

        socket.once('close', this.onTrgSocketClose);
        socket.once('end', this.onTrgSocketEnd);
        socket.once('error', this.onTrgSocketError);
    }

    // Once target socket closes, we need to give time
    // to source socket to receive pending data, so we only call end()
    onTrgSocketClose() {
        if (this.isClosed) return;
        this.log('Target socket closed');
        if (this.srcSocket) this.srcSocket.end();
    }

    onTrgSocketEnd() {
        if (this.isClosed) return;
        this.log('Target socket ended');
        if (this.srcSocket) this.srcSocket.end();
    }

    onTrgSocketError(err) {
        if (this.isClosed) return;
        this.log(`Target socket failed: ${err.stack || err}`);
        this.fail(err);
    }

    maybeAddProxyAuthorizationHeader(headers) {
        const parsed = this.upstreamProxyUrlParsed;
        if (parsed && parsed.username) {
            let auth = parsed.username;
            if (parsed.password) auth += `:${parsed.password}`;
            headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
        }
    }

    /**
     * Checks whether response from upstream proxy is 407 Proxy Authentication Required
     * and if so, responds 502 Bad Gateway to client.
     * @param response
     * @return {boolean}
     */
    checkUpstreamProxy407(response) {
        if (this.upstreamProxyUrlParsed && response.statusCode === 407) {
            this.fail('Invalid credentials provided for the upstream proxy.', 502);
            return true;
        }
        return false;
    }

    fail(err, statusCode) {
        if (this.srcGotResponse) {
            this.log('Source already received a response, just destroying the socket...');
            this.close();
        } else if (statusCode) {
            // Manual error
            this.log(`${err}, responding with custom status code ${statusCode} to client`);
            this.srcResponse.writeHead(statusCode);
            this.srcResponse.end(`${err}`);
        } else if (err.code === 'ENOTFOUND' && this.upstreamProxyUrlParsed) {
            this.log('Upstream proxy not found, sending 502 to client');
            this.srcResponse.writeHead(502);
            this.srcResponse.end('Upstream proxy was not found');
        } else if (err.code === 'ENOTFOUND' && !this.upstreamProxyUrlParsed) {
            this.log('Target server not found, sending 404 to client');
            this.srcResponse.writeHead(404);
            this.srcResponse.end('Target server not found');
        } else {
            this.log('Unknown error, sending 500 to client');
            this.srcResponse.writeHead(500);
            this.srcResponse.end('Internal error in proxy server');
        }
    }

    getStats() {
        return {
            srcTxBytes: this.srcSocket ? this.srcSocket.bytesWritten : null,
            srcRxBytes: this.srcSocket ? this.srcSocket.bytesRead : null,
            trgTxBytes: this.trgSocket ? this.trgSocket.bytesWritten : null,
            trgRxBytes: this.trgSocket ? this.trgSocket.bytesRead : null,
        };
    }

    /**
     * Detaches all listeners and destroys all sockets.
     */
    close() {
        if (!this.isClosed) {
            this.log('Closing handler');

            // Save stats before sockets are destroyed
            const stats = this.getStats();

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

            this.isClosed = true;

            this.emit('close', { stats });
        }
    }
}
