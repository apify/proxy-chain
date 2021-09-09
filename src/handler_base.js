import http from 'http';
import EventEmitter from 'events';
import { RequestError } from './server';

/**
 * Base class for proxy connection handlers. It emits the `destroyed` event
 * when the handler is no longer used.
 */
export default class HandlerBase extends EventEmitter {
    constructor({
        server, id, srcRequest, srcHead, srcResponse, trgParsed, upstreamProxyUrlParsed, proxyHeaders
    }) {
        super();

        if (!server) throw new Error('The "server" option is required');
        if (!id) throw new Error('The "id" option is required');
        if (!srcRequest) throw new Error('The "srcRequest" option is required');
        if (!srcRequest.socket) throw new Error('"srcRequest.socket" cannot be null');
        if (!trgParsed.hostname) throw new Error('The "trgParsed.hostname" option is required');

        this.server = server;
        this.id = id;

        this.srcRequest = srcRequest;
        this.srcHead = srcHead;
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
        this.proxyHeaders = proxyHeaders;

        // Create ServerResponse for the client HTTP request if it doesn't exist
        // NOTE: This is undocumented API, it might break in the future
        if (!this.srcResponse) {
            this.srcResponse = new http.ServerResponse(srcRequest);
            this.srcResponse.shouldKeepAlive = false;
            this.srcResponse.chunkedEncoding = false;
            this.srcResponse.useChunkedEncodingByDefault = false;
            this.srcResponse.assignSocket(this.srcSocket);
        }

        // Bind all event handlers to this instance
        this.bindHandlersToThis([
            'onSrcResponseFinish', 'onSrcResponseError',
            'onSrcSocketEnd', 'onSrcSocketFinish', 'onSrcSocketClose', 'onSrcSocketError',
            'onTrgSocket', 'onTrgSocketEnd', 'onTrgSocketFinish', 'onTrgSocketClose', 'onTrgSocketError',
        ]);

        this.srcResponse.on('error', this.onSrcResponseError);

        // Called for the ServerResponse's "finish" event
        // Normally, Node's "http" module has a "finish" event listener that would
        // take care of closing the socket once the HTTP response has completed, but
        // since we're making this ServerResponse instance manually, that event handler
        // never gets hooked up, so we must manually close the socket...
        this.srcResponse.on('finish', this.onSrcResponseFinish);

        // Forward data directly to source client without any delay
        this.srcSocket.setNoDelay();

        this.srcSocket.on('end', this.onSrcSocketEnd);
        this.srcSocket.on('close', this.onSrcSocketClose);
        this.srcSocket.on('finish', this.onSrcSocketFinish);
        this.srcSocket.on('error', this.onSrcSocketError);
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

    onSrcSocketEnd() {
        if (this.isClosed) return;
        this.log('Source socket ended');
        this.close();
    }

    // On Node 10+, the 'close' event is called only after socket is destroyed,
    // so we also need to listen for the stream 'finish' event
    onSrcSocketFinish() {
        if (this.isClosed) return;
        this.log('Source socket finished');
        this.close();
    }

    // If the client closes the connection prematurely,
    // then immediately destroy the upstream socket, there's nothing we can do with it
    onSrcSocketClose() {
        if (this.isClosed) return;
        this.log('Source socket closed');
        this.close();
    }

    onSrcSocketError(err) {
        if (this.isClosed) return;
        this.log(`Source socket failed: ${err.stack || err}`);
        this.close();
    }

    // This is to address https://github.com/apify/proxy-chain/issues/27
    // It seems that when client closed the connection, the piped target socket
    // can still pump data to it, which caused unhandled "write after end" error
    onSrcResponseError(err) {
        if (this.isClosed) return;
        this.log(`Source response failed: ${err.stack || err}`);
        this.close();
    }

    onSrcResponseFinish() {
        if (this.isClosed) return;
        this.log('Source response finished, ending source socket');
        // NOTE: We cannot destroy the socket, since there might be pending data that wouldn't be delivered!
        // This code is inspired by resOnFinish() in _http_server.js in Node.js code base.
        if (typeof this.srcSocket.destroySoon === 'function') {
            this.srcSocket.destroySoon();
        } else {
            this.srcSocket.end();
        }
    }

    onTrgSocket(socket) {
        if (this.isClosed || this.trgSocket) return;
        this.log('Target socket assigned');

        this.trgSocket = socket;

        // Forward data directly to target server without any delay
        this.trgSocket.setNoDelay();

        socket.on('end', this.onTrgSocketEnd);
        socket.on('finish', this.onTrgSocketFinish);
        socket.on('close', this.onTrgSocketClose);
        socket.on('error', this.onTrgSocketError);
    }

    trgSocketShutdown(msg) {
        if (this.isClosed) return;
        this.log(msg);
        // Once target socket closes, we need to give time
        // to source socket to receive pending data, so we only call end()
        // If socket is closed here instead of response, phantomjs does not properly parse the response as http response.
        if (this.srcResponse) {
            this.srcResponse.end();
        } else if (this.srcSocket) {
            // Handler tunnel chain does not use srcResponse, but needs to close srcSocket
            this.srcSocket.end();
        }
    }

    onTrgSocketEnd() {
        this.trgSocketShutdown('Target socket ended');
    }

    onTrgSocketFinish() {
        this.trgSocketShutdown('Target socket finished');
    }

    onTrgSocketClose() {
        this.trgSocketShutdown('Target socket closed');
    }

    onTrgSocketError(err) {
        if (this.isClosed) return;
        this.log(`Target socket failed: ${err.stack || err}`);
        this.fail(err);
    }

    /**
     * Checks whether response from upstream proxy is 407 Proxy Authentication Required
     * and if so, responds 502 Bad Gateway to client.
     * @param response
     * @return {boolean}
     */
    checkUpstreamProxy407(response) {
        if (this.upstreamProxyUrlParsed && response.statusCode === 407) {
            this.fail(new RequestError('Invalid credentials provided for the upstream proxy.', 502));
            return true;
        }
        return false;
    }

    fail(err) {
        if (this.srcGotResponse) {
            this.log('Source already received a response, just destroying the socket...');
            this.close();
            return;
        }

        this.srcGotResponse = true;
        this.srcResponse.setHeader('Content-Type', 'text/plain; charset=utf-8');

        if (err.statusCode) {
            // Error is RequestError with HTTP status code
            this.log(`${err} Responding with custom status code ${err.statusCode} to client`);
            this.srcResponse.writeHead(err.statusCode);
            this.srcResponse.end(`${err.message}`);
        } else if (err.code === 'ENOTFOUND' && !this.upstreamProxyUrlParsed) {
            this.log('Target server not found, sending 404 to client');
            this.srcResponse.writeHead(404);
            this.srcResponse.end('Target server not found');
        } else if (err.code === 'ENOTFOUND' && this.upstreamProxyUrlParsed) {
            this.log('Upstream proxy not found, sending 502 to client');
            this.srcResponse.writeHead(502);
            this.srcResponse.end('Upstream proxy was not found');
        } else if (err.code === 'ECONNREFUSED') {
            this.log('Upstream proxy refused connection, sending 502 to client');
            this.srcResponse.writeHead(502);
            this.srcResponse.end('Upstream proxy refused connection');
        } else if (err.code === 'ETIMEDOUT') {
            this.log('Connection timed out, sending 502 to client');
            this.srcResponse.writeHead(502);
            this.srcResponse.end('Connection to upstream proxy timed out');
        } else if (err.code === 'ECONNRESET') {
            this.log('Connection lost, sending 502 to client');
            this.srcResponse.writeHead(502);
            this.srcResponse.end('Connection lost');
        } else if (err.code === 'EPIPE') {
            this.log('Socket closed before write, sending 502 to client');
            this.srcResponse.writeHead(502);
            this.srcResponse.end('Connection interrupted');
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
     * Detaches all listeners, destroys all sockets and emits the 'close' event.
     */
    close() {
        if (this.isClosed) return;

        this.log('Closing handler');
        this.isClosed = true;

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

        this.emit('close', { stats });
    }
}
