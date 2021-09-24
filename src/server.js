const http = require('http');
const util = require('util');
const EventEmitter = require('events');
const { parseAuthorizationHeader } = require('./utils/parse_authorization_header');
const { redactUrl } = require('./utils/redact_url');
const { nodeify } = require('./utils/nodeify');
const { getTargetStats } = require('./utils/count_target_bytes');
const { RequestError } = require('./request_error');
const { chain } = require('./chain');
const { forward } = require('./forward');
const { direct } = require('./direct');
const { handleCustomResponse } = require('./custom_response');

// TODO:
// - Fail gracefully if target proxy fails (invalid credentials or non-existent)
// - Implement this requirement from rfc7230
//   "A proxy MUST forward unrecognized header fields unless the field-name
//    is listed in the Connection header field (Section 6.1) or the proxy
//    is specifically configured to block, or otherwise transform, such
//    fields.  Other recipients SHOULD ignore unrecognized header fields.
//    These requirements allow HTTP's functionality to be enhanced without
//    requiring prior update of deployed intermediaries."
// - Add param to prepareRequestFunction() that would allow the caller to kill a connection

// TODO:
// - Use connection pooling and maybe other stuff from:
// https://github.com/request/tunnel-agent/blob/master/index.js
// https://github.com/request/request/blob/master/lib/tunnel.js

const DEFAULT_AUTH_REALM = 'ProxyChain';
const DEFAULT_PROXY_SERVER_PORT = 8000;

/**
 * Represents the proxy server.
 * It emits the 'requestFailed' event on unexpected request errors, with the following parameter `{ error, request }`.
 * It emits the 'connectionClosed' event when connection to proxy server is closed, with parameter `{ connectionId, stats }`.
 */
class Server extends EventEmitter {
    /**
     * Initializes a new instance of Server class.
     * @param options
     * @param [options.port] Port where the server will listen. By default 8000.
     * @param [options.prepareRequestFunction] Custom function to authenticate proxy requests,
     * provide URL to chained upstream proxy or potentially provide function that generates a custom response to HTTP requests.
     * It accepts a single parameter which is an object:
     * ```{
     *   connectionId: Number,
     *   request: Object,
     *   username: String,
     *   password: String,
     *   hostname: String,
     *   port: Number,
     *   isHttp: Boolean
     * }```
     * and returns an object (or promise resolving to the object) with following form:
     * ```{
     *   requestAuthentication: Boolean,
     *   upstreamProxyUrl: String,
     *   customResponseFunction: Function
     * }```
     * If `upstreamProxyUrl` is false-ish value, no upstream proxy is used.
     * If `prepareRequestFunction` is not set, the proxy server will not require any authentication
     * and will not use any upstream proxy.
     * If `customResponseFunction` is set, it will be called to generate a custom response to the HTTP request.
     * It should not be used together with `upstreamProxyUrl`.
     * @param [options.authRealm] Realm used in the Proxy-Authenticate header and also in the 'Server' HTTP header. By default it's `ProxyChain`.
     * @param [options.verbose] If true, the server logs
     */
    constructor(options = {}) {
        super();

        if (options.port === undefined || options.port === null) {
            this.port = DEFAULT_PROXY_SERVER_PORT;
        } else {
            this.port = options.port;
        }

        this.prepareRequestFunction = options.prepareRequestFunction;
        this.authRealm = options.authRealm || DEFAULT_AUTH_REALM;
        this.verbose = !!options.verbose;

        this.server = http.createServer();
        this.server.on('clientError', this.onClientError.bind(this));
        this.server.on('request', this.onRequest.bind(this));
        this.server.on('connect', this.onConnect.bind(this));
        this.server.on('connection', this.onConnection.bind(this));

        this.lastHandlerId = 0;
        this.stats = {
            httpRequestCount: 0,
            connectRequestCount: 0,
        };

        this.connections = new Map();
    }

    log(connectionId, str) {
        if (this.verbose) {
            const logPrefix = connectionId ? `${connectionId} | ` : '';
            console.log(`ProxyServer[${this.port}]: ${logPrefix}${str}`);
        }
    }

    onClientError(err, socket) {
        this.log(socket.proxyChainId, `onClientError: ${err}`);

        // https://nodejs.org/api/http.html#http_event_clienterror
        if (err.code === 'ECONNRESET' || !socket.writable) {
            return;
        }

        this.sendSocketResponse(socket, 400, {}, 'Invalid request');
    }

    /**
     * Assigns a unique ID to the socket and keeps the register up to date.
     * Needed for abrupt close of the server.
     * @param {net.Socket} socket
     */
    registerConnection(socket) {
        const weakId = Math.random().toString(36).slice(2);
        const unique = Symbol(weakId);

        socket.proxyChainId = unique;
        this.connections.set(unique, socket);

        socket.on('close', () => {
            this.emit('connectionClosed', {
                connectionId: unique,
                stats: this.getConnectionStats(unique),
            });

            this.connections.delete(unique);
        });
    }

    /**
     * Handles incoming sockets, useful for error handling
     */
    onConnection(socket) {
        this.registerConnection(socket);

        // We need to consume socket errors, because the handlers are attached asynchronously.
        // See https://github.com/apify/proxy-chain/issues/53
        socket.on('error', (err) => {
            // Handle errors only if there's no other handler
            if (this.listenerCount('error') === 1) {
                this.log(socket.proxyChainId, `Source socket emitted error: ${err.stack || err}`);
            }
        });
    }

    normalizeHandlerError(error) {
        if (error.message === 'Username contains an invalid colon') {
            return new RequestError('Invalid colon in username in upstream proxy credentials', 502);
        }

        if (error.message === '407 Proxy Authentication Required') {
            return new RequestError('Invalid upstream proxy credentials', 502);
        }

        if (error.code === 'ENOTFOUND') {
            if (error.proxy) {
                return new RequestError('Failed to connect to upstream proxy', 502);
            }

            return new RequestError('Target website does not exist', 404);
        }

        return error;
    }

    /**
     * Handles normal HTTP request by forwarding it to target host or the upstream proxy.
     */
    async onRequest(request, response) {
        try {
            const handlerOpts = await this.prepareRequestHandling(request);
            handlerOpts.srcResponse = response;

            if (handlerOpts.customResponseFunction) {
                this.log(request.socket.proxyChainId, 'Using HandlerCustomResponse');
                return await handleCustomResponse(request, response, handlerOpts);
            }

            this.log(request.socket.proxyChainId, 'Using forward');
            return await forward(request, response, handlerOpts);
        } catch (error) {
            this.failRequest(request, this.normalizeHandlerError(error));
        }
    }

    /**
     * Handles HTTP CONNECT request by setting up a tunnel either to target host or to the upstream proxy.
     * @param request
     * @param socket
     * @param head The first packet of the tunneling stream (may be empty)
     */
    async onConnect(request, socket, head) {
        try {
            const handlerOpts = await this.prepareRequestHandling(request);
            handlerOpts.srcHead = head;

            const data = { request, sourceSocket: socket, head, handlerOpts, server: this };

            if (handlerOpts.upstreamProxyUrlParsed) {
                this.log(socket.proxyChainId, `Using HandlerTunnelChain with ${redactUrl(handlerOpts.upstreamProxyUrlParsed)} to ${request.url}`);
                return await chain(data);
            }

            this.log(socket.proxyChainId, `Using HandlerTunnelDirect to ${request.url}`);
            return await direct(data);
        } catch (error) {
            this.failRequest(request, this.normalizeHandlerError(error));
        }
    }

    /**
     * Prepares handler options from a request.
     * @param request
     * @see {prepareRequestHandling}
     */
    getHandlerOpts(request) {
        const handlerOpts = {
            server: this,
            id: ++this.lastHandlerId,
            srcRequest: request,
            srcHead: null,
            trgParsed: null,
            upstreamProxyUrlParsed: null,
        };

        this.log(request.socket.proxyChainId, `!!! Handling ${request.method} ${request.url} HTTP/${request.httpVersion}`);

        if (request.method === 'CONNECT') {
            handlerOpts.isHttp = false;

            // CONNECT server.example.com:80 HTTP/1.1
            handlerOpts.trgParsed = new URL(`connect://${request.url}`);

            if (!handlerOpts.trgParsed.hostname || !handlerOpts.trgParsed.port) {
                throw new RequestError(`Target "${request.url}" could not be parsed`, 400);
            }

            this.stats.connectRequestCount++;
        } else {
            // The request should look like:
            //   GET http://server.example.com:80/some-path HTTP/1.1
            // Note that RFC 7230 says:
            // "When making a request to a proxy, other than a CONNECT or server-wide
            //  OPTIONS request (as detailed below), a client MUST send the target
            //  URI in absolute-form as the request-target"

            let parsed;
            try {
                parsed = new URL(request.url);
            } catch (error) {
                // If URL is invalid, throw HTTP 400 error
                throw new RequestError(`Target "${request.url}" could not be parsed`, 400);
            }

            // Only HTTP is supported, other protocols such as HTTP or FTP must use the CONNECT method
            if (parsed.protocol !== 'http:') {
                throw new RequestError(`Only HTTP protocol is supported (was ${parsed.protocol})`, 400);
            }

            handlerOpts.trgParsed = parsed;
            handlerOpts.isHttp = true;

            this.stats.httpRequestCount++;
        }

        return handlerOpts;
    }

    /**
     * Calls `this.prepareRequestFunction` with normalized options.
     * @param request
     * @param handlerOpts
     */
    async callPrepareRequestFunction(request, handlerOpts) {
        // Authenticate the request using a user function (if provided)
        if (this.prepareRequestFunction) {
            const funcOpts = {
                connectionId: request.socket.proxyChainId,
                request,
                username: null,
                password: null,
                hostname: handlerOpts.trgParsed.hostname,
                port: handlerOpts.trgParsed.port,
                isHttp: handlerOpts.isHttp,
            };

            const proxyAuth = request.headers['proxy-authorization'];
            if (proxyAuth) {
                const auth = parseAuthorizationHeader(proxyAuth);

                if (!auth) {
                    throw new RequestError('Invalid "Proxy-Authorization" header', 400);
                }

                if (auth.type !== 'Basic') {
                    throw new RequestError('The "Proxy-Authorization" header must have the "Basic" type.', 400);
                }

                funcOpts.username = auth.username;
                funcOpts.password = auth.password;
            }

            // User function returns a result directly or a promise
            return this.prepareRequestFunction(funcOpts);
        }

        return { requestAuthentication: false, upstreamProxyUrlParsed: null };
    }

    /**
     * Authenticates a new request and determines upstream proxy URL using the user function.
     * Returns a promise resolving to an object that can be used to run a handler.
     * @param request
     */
    async prepareRequestHandling(request) {
        const handlerOpts = this.getHandlerOpts(request);
        const funcResult = await this.callPrepareRequestFunction(request, handlerOpts);

        // If not authenticated, request client to authenticate
        if (funcResult && funcResult.requestAuthentication) {
            throw new RequestError(funcResult.failMsg || 'Proxy credentials required.', 407);
        }

        if (funcResult && funcResult.upstreamProxyUrl) {
            try {
                handlerOpts.upstreamProxyUrlParsed = new URL(funcResult.upstreamProxyUrl);
            } catch (error) {
                throw new Error(`Invalid "upstreamProxyUrl" provided: ${error} (was "${funcResult.upstreamProxyUrl}"`);
            }

            if (handlerOpts.upstreamProxyUrlParsed.protocol !== 'http:') {
                // eslint-disable-next-line max-len
                throw new Error(`Invalid "upstreamProxyUrl" provided: URL must have the "http" protocol (was "${funcResult.upstreamProxyUrl}")`);
            }
        }

        if (funcResult && funcResult.customResponseFunction) {
            this.log(request.socket.proxyChainId, 'Using custom response function');

            handlerOpts.customResponseFunction = funcResult.customResponseFunction;

            if (!handlerOpts.isHttp) {
                throw new Error('The "customResponseFunction" option can only be used for HTTP requests.');
            }

            if (typeof (handlerOpts.customResponseFunction) !== 'function') {
                throw new Error('The "customResponseFunction" option must be a function.');
            }
        }

        if (handlerOpts.upstreamProxyUrlParsed) {
            this.log(request.socket.proxyChainId, `Using upstream proxy ${redactUrl(handlerOpts.upstreamProxyUrlParsed)}`);
        }

        return handlerOpts;
    }

    /**
     * Sends a HTTP error response to the client.
     * @param request
     * @param error
     */
    failRequest(request, error) {
        const connectionId = request.socket.proxyChainId;

        if (error.name === 'RequestError') {
            this.log(connectionId, `Request failed (status ${error.statusCode}): ${error.message}`);
            this.sendSocketResponse(request.socket, error.statusCode, error.headers, error.message);
        } else {
            this.log(connectionId, `Request failed with error: ${error.stack || error}`);
            this.sendSocketResponse(request.socket, 500, {}, 'Internal error in proxy server');
            this.emit('requestFailed', { error, request });
        }

        // Emit 'connectionClosed' event if request failed and connection was already reported
        this.log(connectionId, 'Closed because request failed with error');
    }

    /**
     * Sends a simple HTTP response to the client and forcibly closes the connection.
     * This invalidates the ServerResponse instance (if present).
     * We don't know the state of the response anyway.
     * Writing directly to the socket seems to be the easiest solution.
     * @param socket
     * @param statusCode
     * @param headers
     * @param message
     */
    sendSocketResponse(socket, statusCode = 500, caseSensitiveHeaders = {}, message = '') {
        try {
            const headers = Object.fromEntries(
                Object.entries(caseSensitiveHeaders).map(
                    ([name, value]) => [name.toLowerCase(), value],
                ),
            );

            headers.connection = 'close';
            headers['content-length'] = String(Buffer.byteLength(message));

            // TODO: we should use ??= here
            headers.server = headers.server || this.authRealm;
            headers['content-type'] = headers['content-type'] || 'text/plain; charset=utf-8';

            if (statusCode === 407 && !headers['proxy-authenticate']) {
                headers['proxy-authenticate'] = `Basic realm="${this.authRealm}"`;
            }

            let msg = `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] || 'Unknown Status Code'}\r\n`;
            for (const [key, value] of Object.entries(headers)) {
                msg += `${key}: ${value}\r\n`;
            }
            msg += `\r\n${message}`;

            // Unfortunately it's not possible to send RST in Node.js yet.
            // See https://github.com/nodejs/node/issues/27428
            socket.setTimeout(1000, () => {
                socket.destroy();
            });

            // This sends FIN, meaning we still can receive data.
            socket.end(msg);
        } catch (err) {
            this.log(socket.proxyChainId, `Unhandled error in sendResponse(), will be ignored: ${err.stack || err}`);
        }
    }

    /**
     * Starts listening at a port specified in the constructor.
     * @param callback Optional callback
     * @return {(Promise|undefined)}
     */
    listen(callback) {
        const promise = new Promise((resolve, reject) => {
            // Unfortunately server.listen() is not a normal function that fails on error,
            // so we need this trickery
            const onError = (err) => {
                this.log(null, `Listen failed: ${err}`);
                removeListeners();
                reject(err);
            };
            const onListening = () => {
                this.port = this.server.address().port;
                this.log(null, 'Listening...');
                removeListeners();
                resolve();
            };
            const removeListeners = () => {
                this.server.removeListener('error', onError);
                this.server.removeListener('listening', onListening);
            };

            this.server.on('error', onError);
            this.server.on('listening', onListening);
            this.server.listen(this.port);
        });

        return nodeify(promise, callback);
    }

    /**
     * Gets array of IDs of all active connections.
     * @returns {*}
     */
    getConnectionIds() {
        return [...this.connections.keys()];
    }

    /**
     * Gets data transfer statistics of a specific proxy connection.
     * @param {Number} connectionId ID of the connection.
     * It is passed to `prepareRequestFunction` function.
     * @return {Object} An object with statistics { srcTxBytes, srcRxBytes, trgTxBytes, trgRxBytes },
     * or null if connection does not exist or has been closed.
     */
    getConnectionStats(connectionId) {
        const socket = this.connections.get(connectionId);
        if (!socket) return undefined;

        const targetStats = getTargetStats(socket);

        const result = {
            srcTxBytes: socket.bytesWritten,
            srcRxBytes: socket.bytesRead,
            trgTxBytes: targetStats.bytesWritten,
            trgRxBytes: targetStats.bytesRead,
        };

        return result;
    }

    /**
     * Closes the proxy server.
     * @param [closeConnections] If true, then all the pending connections from clients
     * to targets and upstream proxies will be forcibly aborted.
     * @param callback
     */
    close(closeConnections, callback) {
        if (typeof closeConnections === 'function') {
            callback = closeConnections;
            closeConnections = false;
        }

        if (closeConnections) {
            this.log(null, 'Closing pending sockets');

            for (const socket of this.connections.values()) {
                socket.destroy();
            }

            this.connections.clear();

            this.log(null, `Destroyed ${this.connections.size} pending sockets`);
        }

        if (this.server) {
            const { server } = this;
            this.server = null;
            const promise = util.promisify(server.close).bind(server)();
            return nodeify(promise, callback);
        }
    }
}

module.exports = {
    Server,
};
