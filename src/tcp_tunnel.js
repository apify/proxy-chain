import http from 'http';
import { maybeAddProxyAuthorizationHeader } from './tools';

/**
 * Represents a connection from source client to an external proxy using HTTP CONNECT tunnel, allows TCP connection.
 */
export default class TcpTunnel {
    constructor({
        srcSocket, trgParsed, upstreamProxyUrlParsed, log,
    }) {
        this.log = log;

        // Bind all event handlers to this instance
        this.bindHandlersToThis([
            'onSrcSocketClose', 'onSrcSocketEnd', 'onSrcSocketError',
            'onTrgSocket', 'onTrgSocketClose', 'onTrgSocketEnd', 'onTrgSocketError',
            'onTrgRequestConnect', 'onTrgRequestAbort', 'onTrgRequestError',
        ]);

        if (!trgParsed.hostname) throw new Error('The "trgParsed.hostname" option is required');
        if (!trgParsed.port) throw new Error('The "trgParsed.port" option is required');

        this.trgRequest = null;
        this.trgSocket = null;
        this.trgParsed = trgParsed;
        this.trgParsed.port = this.trgParsed.port || DEFAULT_TARGET_PORT;

        this.srcSocket = srcSocket;
        this.srcSocket.on('close', this.onSrcSocketClose);
        this.srcSocket.on('end', this.onSrcSocketEnd);
        this.srcSocket.on('error', this.onSrcSocketError);

        this.upstreamProxyUrlParsed = upstreamProxyUrlParsed;

        this.isClosed = false;
    }

    bindHandlersToThis(handlerNames) {
        handlerNames.forEach((evt) => {
            this[evt] = this[evt].bind(this);
        });
    }

    run() {
        this.log('Connecting to upstream proxy...');

        const options = {
            method: 'CONNECT',
            hostname: this.upstreamProxyUrlParsed.hostname,
            port: this.upstreamProxyUrlParsed.port,
            path: `${this.trgParsed.hostname}:${this.trgParsed.port}`,
            headers: {},
        };

        maybeAddProxyAuthorizationHeader(this.upstreamProxyUrlParsed, options.headers);

        this.trgRequest = http.request(options);

        this.trgRequest.on('connect', this.onTrgRequestConnect);
        this.trgRequest.on('abort', this.onTrgRequestAbort);
        this.trgRequest.on('socket', this.onTrgSocket);
        this.trgRequest.on('error', this.onTrgRequestError);

        // Send the data
        this.trgRequest.end();
    }

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

    onTrgSocket(socket) {
        if (this.isClosed) return;

        this.log('Target socket assigned');

        this.trgSocket = socket;

        socket.on('close', this.onTrgSocketClose);
        socket.on('end', this.onTrgSocketEnd);
        socket.on('error', this.onTrgSocketError);
    }

    // Once target socket closes, we need to give time
    // to source socket to receive pending data, so we only call end() after a little while.
    // One second should be about enough.
    onTrgSocketClose() {
        if (this.isClosed) return;
        this.log('Target socket closed');
        setTimeout(() => {
            if (this.srcSocket) this.srcSocket.end();
        }, 1000);
    }

    // Same as onTrgSocketClose() above
    onTrgSocketEnd() {
        if (this.isClosed) return;
        this.log('Target socket ended');
        setTimeout(() => {
            if (this.srcSocket) this.srcSocket.end();
        }, 1000);
    }

    onTrgSocketError(err) {
        if (this.isClosed) return;
        this.log(`Target socket failed: ${err.stack || err}`);
        this.fail(err);
    }

    onTrgRequestConnect(response) {
        if (this.isClosed) return;
        this.log('Connected to upstream proxy');

        if (this.checkUpstreamProxy407(response)) return;

        // Setup bi-directional tunnel
        this.trgSocket.pipe(this.srcSocket);
        this.srcSocket.pipe(this.trgSocket);

        this.srcSocket.resume();
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
        } else if (err.code === 'ENOTFOUND' && !this.upstreamProxyUrlParsed) {
            this.log('Target server not found, sending 404 to client');
        } else if (err.code === 'ENOTFOUND' && this.upstreamProxyUrlParsed) {
            this.log('Upstream proxy not found, sending 502 to client');
        } else if (err.code === 'ECONNREFUSED') {
            this.log('Upstream proxy refused connection, sending 502 to client');
        } else if (err.code === 'ETIMEDOUT') {
            this.log('Connection timed out, sending 502 to client');
        } else if (err.code === 'ECONNRESET') {
            this.log('Connection lost, sending 502 to client');
        } else if (err.code === 'EPIPE') {
            this.log('Socket closed before write, sending 502 to client');
        } else {
            this.log('Unknown error, sending 500 to client');
        }
    }

    /**
     * Detaches all listeners and destroys all sockets.
     */
    close() {
        if (!this.isClosed) {
            this.log('Closing handler');

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
        }
    }
}
