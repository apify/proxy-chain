import http from 'http';
import util from 'util';
import EventEmitter from 'events';
import _ from 'underscore';
import {
    parseHostHeader, parseProxyAuthorizationHeader, parseUrl, redactParsedUrl, nodeify,
} from './tools';
import HandlerForward from './handler_forward';
import HandlerTunnelDirect from './handler_tunnel_direct';
import HandlerTunnelChain from './handler_tunnel_chain';
import HandlerCustomResponse from './handler_custom_response';

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
const DEFAULT_TARGET_PORT = 80;

const REQUEST_ERROR_NAME = 'RequestError';

/**
 * Represents custom request error. The message is emitted as HTTP response
 * with a specific HTTP code and headers.
 * If this error is thrown from the `prepareRequestFunction` function,
 * the message and status code is sent to client.
 * By default, the response will have Content-Type: text/plain
 * and for the 407 status the Proxy-Authenticate header will be added.
 */
export class RequestError extends Error {
    constructor(message, statusCode, headers) {
        super(message);
        this.name = REQUEST_ERROR_NAME;
        this.statusCode = statusCode;
        this.headers = headers;

        Error.captureStackTrace(this, RequestError);
    }
}

/**
 * Represents the proxy server.
 * It emits the 'requestFailed' event on unexpected request errors, with the following parameter `{ error, request }`.
 * It emits the 'connectionClosed' event when connection to proxy server is closed, with parameter `{ connectionId, stats }`.
 */
export class Server extends EventEmitter {
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
    constructor(options) {
        super();

        options = options || {};

        if (options.port === undefined || options.port === null) {
            this.port = DEFAULT_PROXY_SERVER_PORT;
        } else {
            this.port = options.port;
        }
        this.prepareRequestFunction = options.prepareRequestFunction;
        this.authRealm = options.authRealm || DEFAULT_AUTH_REALM;
        this.verbose = !!options.verbose;

        // Key is handler ID, value is HandlerXxx instance
        this.handlers = {};
        this.lastHandlerId = 0;

        this.server = http.createServer();
        this.server.on('clientError', this.onClientError.bind(this));
        this.server.on('request', this.onRequest.bind(this));
        this.server.on('connect', this.onConnect.bind(this));

        this.stats = {
            httpRequestCount: 0,
            connectRequestCount: 0,
        };
    }

    log(handlerId, str) {
        if (this.verbose) {
            const logPrefix = handlerId ? `${handlerId} | ` : '';
            console.log(`ProxyServer[${this.port}]: ${logPrefix}${str}`);
        }
    }

    onClientError(err, socket) {
        this.log(null, `onClientError: ${err}`);
        this.sendResponse(socket, 400, null, 'Invalid request');
    }

    /**
     * Handles normal HTTP request by forwarding it to target host or the upstream proxy.
     */
    onRequest(request, response) {
        let handlerOpts;
        this.prepareRequestHandling(request)
            .then((result) => {
                handlerOpts = result;
                handlerOpts.srcResponse = response;

                let handler;
                if (handlerOpts.customResponseFunction) {
                    this.log(handlerOpts.id, 'Using HandlerCustomResponse');
                    handler = new HandlerCustomResponse(handlerOpts);
                } else {
                    this.log(handlerOpts.id, 'Using HandlerForward');
                    handler = new HandlerForward(handlerOpts);
                }

                this.handlerRun(handler);
            })
            .catch((err) => {
                this.failRequest(request, err, handlerOpts);
            });
    }

    /**
     * Handles HTTP CONNECT request by setting up a tunnel either to target host or to the upstream proxy.
     * @param request
     * @param socket
     * @param head The first packet of the tunneling stream (may be empty)
     */
    onConnect(request, socket, head) {
        let handlerOpts;
        this.prepareRequestHandling(request)
            .then((result) => {
                handlerOpts = result;
                handlerOpts.srcHead = head;

                let handler;
                if (handlerOpts.upstreamProxyUrlParsed) {
                    this.log(handlerOpts.id, 'Using HandlerTunnelChain');
                    handler = new HandlerTunnelChain(handlerOpts);
                } else {
                    this.log(handlerOpts.id, 'Using HandlerTunnelDirect');
                    handler = new HandlerTunnelDirect(handlerOpts);
                }

                this.handlerRun(handler);
            })
            .catch((err) => {
                this.failRequest(request, err, handlerOpts);
            });
    }

    /**
     * Authenticates a new request and determines upstream proxy URL using the user function.
     * Returns a promise resolving to an object that can be passed to construcot of one of the HandlerXxx classes.
     * @param request
     */
    prepareRequestHandling(request) {
        // console.log('XXX prepareRequestHandling');
        // console.dir(_.pick(request, 'url', 'method'));
        // console.dir(url.parse(request.url));

        const handlerOpts = {
            server: this,
            id: ++this.lastHandlerId,
            srcRequest: request,
            srcHead: null,
            trgParsed: null,
            upstreamProxyUrlParsed: null,
        };

        this.log(handlerOpts.id, `!!! Handling ${request.method} ${request.url} HTTP/${request.httpVersion}`);

        const { socket } = request;
        let isHttp = false;

        // We need to consume socket errors, otherwise they could crash the entire process.
        // See https://github.com/apify/proxy-chain/issues/53
        // TODO: HandlerBase will also attach its own 'error' handler, we should only attach this one
        //  if HandlerBase doesn't do it, to avoid duplicate logs
        socket.on('error', (err) => {
            this.log(handlerOpts.id, `Source socket emitted error: ${err.stack || err}`);
        });

        return Promise.resolve()
            .then(() => {
                // console.dir(_.pick(request, 'url', 'headers', 'method'));
                // Determine target hostname and port
                if (request.method === 'CONNECT') {
                    // The request should look like:
                    //   CONNECT server.example.com:80 HTTP/1.1
                    // Note that request.url contains the "server.example.com:80" part
                    handlerOpts.trgParsed = parseHostHeader(request.url);

                    // If srcRequest.url does not match the regexp tools.HOST_HEADER_REGEX
                    // or the url is too long it will not be parsed so we throw error here.
                    if (!handlerOpts.trgParsed) {
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
                        parsed = parseUrl(request.url);
                    } catch (e) {
                        // If URL is invalid, throw HTTP 400 error
                        throw new RequestError(`Target "${request.url}" could not be parsed`, 400);
                    }
                    // If srcRequest.url is something like '/some-path', this is most likely a normal HTTP request
                    if (!parsed.protocol) {
                        throw new RequestError('Hey, good try, but I\'m a HTTP proxy, not your ordinary web server :)', 400);
                    }
                    // Only HTTP is supported, other protocols such as HTTP or FTP must use the CONNECT method
                    if (parsed.protocol !== 'http:') {
                        throw new RequestError(`Only HTTP protocol is supported (was ${parsed.protocol})`, 400);
                    }

                    handlerOpts.trgParsed = parsed;
                    isHttp = true;

                    this.stats.httpRequestCount++;
                }

                handlerOpts.trgParsed.port = handlerOpts.trgParsed.port || DEFAULT_TARGET_PORT;

                // Authenticate the request using a user function (if provided)
                if (!this.prepareRequestFunction) return { requestAuthentication: false, upstreamProxyUrlParsed: null };

                // Pause the socket so that no data is lost
                socket.pause();

                const funcOpts = {
                    connectionId: handlerOpts.id,
                    request,
                    username: null,
                    password: null,
                    hostname: handlerOpts.trgParsed.hostname,
                    port: handlerOpts.trgParsed.port,
                    isHttp,
                };

                const proxyAuth = request.headers['proxy-authorization'];
                if (proxyAuth) {
                    const auth = parseProxyAuthorizationHeader(proxyAuth);
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
            })
            .then((funcResult) => {
                // If not authenticated, request client to authenticate
                if (funcResult && funcResult.requestAuthentication) {
                    throw new RequestError(funcResult.failMsg || 'Proxy credentials required.', 407);
                }

                if (funcResult && funcResult.upstreamProxyUrl) {
                    try {
                        handlerOpts.upstreamProxyUrlParsed = parseUrl(funcResult.upstreamProxyUrl);
                    } catch (e) {
                        throw new Error(`Invalid "upstreamProxyUrl" provided: ${e} (was "${funcResult.upstreamProxyUrl}"`);
                    }

                    if (!handlerOpts.upstreamProxyUrlParsed.hostname || !handlerOpts.upstreamProxyUrlParsed.port) {
                        throw new Error(`Invalid "upstreamProxyUrl" provided: URL must have hostname and port (was "${funcResult.upstreamProxyUrl}")`); // eslint-disable-line max-len
                    }
                    if (handlerOpts.upstreamProxyUrlParsed.protocol !== 'http:') {
                        throw new Error(`Invalid "upstreamProxyUrl" provided: URL must have the "http" protocol (was "${funcResult.upstreamProxyUrl}")`); // eslint-disable-line max-len
                    }
                    if (/:/.test(handlerOpts.upstreamProxyUrlParsed.username)) {
                        throw new Error('Invalid "upstreamProxyUrl" provided: The username cannot contain the colon (:) character according to RFC 7617.'); // eslint-disable-line max-len
                    }
                }

                if (funcResult && funcResult.customResponseFunction) {
                    this.log(handlerOpts.id, 'Using custom response function');
                    handlerOpts.customResponseFunction = funcResult.customResponseFunction;
                    if (!isHttp) {
                        throw new Error('The "customResponseFunction" option can only be used for HTTP requests.');
                    }
                    if (typeof (handlerOpts.customResponseFunction) !== 'function') {
                        throw new Error('The "customResponseFunction" option must be a function.');
                    }
                }

                if (funcResult && funcResult.proxyHeaders) {
                    this.log(handlerOpts.id, 'Using custom proxy headers');
                    handlerOpts.proxyHeaders = funcResult.proxyHeaders;
                }

                if (handlerOpts.upstreamProxyUrlParsed) {
                    this.log(handlerOpts.id, `Using upstream proxy ${redactParsedUrl(handlerOpts.upstreamProxyUrlParsed)}`);
                }

                return handlerOpts;
            })
            .finally(() => {
                if (this.prepareRequestFunction) socket.resume();
            });
    }

    handlerRun(handler) {
        this.handlers[handler.id] = handler;

        handler.once('close', ({ stats }) => {
            this.emit('connectionClosed', {
                connectionId: handler.id,
                stats,
            });
            delete this.handlers[handler.id];
            this.log(handler.id, '!!! Closed and removed from server');
        });

        handler.once('tunnelConnectResponded', ({ response, socket, head }) => {
            this.emit('tunnelConnectResponded', {
                connectionId: handler.id,
                response,
                socket,
                head,
            });
        });

        handler.run();
    }

    /**
     * Sends a HTTP error response to the client.
     * @param request
     * @param err
     */
    failRequest(request, err, handlerOpts) {
        const handlerId = handlerOpts ? handlerOpts.id : null;

        if (err.name === REQUEST_ERROR_NAME) {
            this.log(handlerId, `Request failed (status ${err.statusCode}): ${err.message}`);
            this.sendResponse(request.socket, err.statusCode, err.headers, err.message);
        } else {
            this.log(handlerId, `Request failed with unknown error: ${err.stack || err}`);
            this.sendResponse(request.socket, 500, null, 'Internal error in proxy server');
            this.emit('requestFailed', { error: err, request });
        }

        // Emit 'connectionClosed' event if request failed and connection was already reported
        if (handlerOpts) {
            this.log(handlerId, 'Closed because request failed with error');
            this.emit('connectionClosed', {
                connectionId: handlerOpts.id,
                stats: { srcTxBytes: 0, srcRxBytes: 0 },
            });
        }
    }

    /**
     * Sends a simple HTTP response to the client and forcibly closes the connection.
     * @param socket
     * @param statusCode
     * @param headers
     * @param message
     */
    sendResponse(socket, statusCode, headers, message) {
        try {
            headers = headers || {};

            // TODO: We should use fully case-insensitive lookup here!
            if (!headers['Content-Type'] && !headers['content-type']) {
                headers['Content-Type'] = 'text/plain; charset=utf-8';
            }
            if (statusCode === 407 && !headers['Proxy-Authenticate'] && !headers['proxy-authenticate']) {
                headers['Proxy-Authenticate'] = `Basic realm="${this.authRealm}"`;
            }
            if (!headers.Server) {
                headers.Server = this.authRealm;
            }
            // These headers are required by e.g. PhantomJS, otherwise the connection would time out!
            if (!headers.Connection) {
                headers.Connection = 'close';
            }
            if (!headers['Content-Length'] && !headers['content-length']) {
                headers['Content-Length'] = Buffer.byteLength(message);
            }

            let msg = `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\n`;
            _.each(headers, (value, key) => {
                msg += `${key}: ${value}\r\n`;
            });
            msg += `\r\n${message}`;

            // console.log("RESPONSE:\n" + msg);

            socket.write(msg, () => {
                socket.end();

                // Unfortunately calling end() will not close the socket if client refuses to close it.
                // Hence calling destroy after a short while. One second should be more than enough
                // to send out this small amount data.
                setTimeout(() => {
                    socket.destroy();
                }, 1000);
            });
        } catch (err) {
            this.log(null, `Unhandled error in sendResponse(), will be ignored: ${err.stack || err}`);
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
        return _.keys(this.handlers);
    }

    /**
     * Gets data transfer statistics of a specific proxy connection.
     * @param {Number} connectionId ID of the connection handler.
     * It is passed to `prepareRequestFunction` function.
     * @return {Object} An object with statistics { srcTxBytes, srcRxBytes, trgTxBytes, trgRxBytes },
     * or null if connection does not exist or has been closed.
     */
    getConnectionStats(connectionId) {
        const handler = this.handlers && this.handlers[connectionId];
        if (!handler) return undefined;

        return handler.getStats();
    }

    /**
     * Closes the proxy server.
     * @param [closeConnections] If true, then all the pending connections from clients
     * to targets and upstream proxies will be forcibly aborted.
     * @param callback
     */
    close(closeConnections, callback) {
        if (typeof (closeConnections) === 'function') {
            callback = closeConnections;
            closeConnections = false;
        }

        if (closeConnections) {
            this.log(null, 'Closing pending handlers');
            let count = 0;
            _.each(this.handlers, (handler) => {
                count++;
                handler.close();
            });
            this.log(null, `Destroyed ${count} pending handlers`);
        }

        if (this.server) {
            const { server } = this;
            this.server = null;
            const promise = util.promisify(server.close).bind(server)();
            return nodeify(promise, callback);
        }
    }
}
