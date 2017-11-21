import http from 'http';
import url from 'url';
import EventEmitter from 'events';
import _ from 'underscore';
import Promise from 'bluebird';

import { parseHostHeader, parseProxyAuthorizationHeader } from './tools';
import HandlerForward from './handler_forward';
import HandlerTunnelDirect from './handler_tunnel_direct';
import HandlerTunnelChain from './handler_tunnel_chain';


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

const DEFAULT_AUTH_REALM = 'Proxy';
const DEFAULT_PROXY_SERVER_PORT = 8000;
const DEFAULT_TARGET_PORT = 80;

const REQUEST_ERROR_NAME = 'RequestError';

class RequestError extends Error {
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
 * It emits 'requestFailed' event on unexpected request errors.
 */
export class Server extends EventEmitter {
    /**
     * Initializes a new instance of Server class.
     * @param options
     * @param [options.port] Port where the server the server will listen. By default 8000.
     * @param [options.prepareRequestFunction] Custom function to authenticate proxy requests
     * and provide URL to chained upstream proxy. It accepts a single parameter which is an object:
     * `{ request: Object, username: String, password: String, hostname: String, port: Number, isHttp: Boolean }`
     * and returns an object (or promise resolving to the object) with following form:
     * `{ requestAuthentication: Boolean, upstreamProxyUrl: String }`
     * If `upstreamProxyUrl` is false-ish value, no upstream proxy is used.
     * If `prepareRequestFunction` is not set, the proxy server will not require any authentication
     * and with not use any upstream proxy.
     * @param [options.authRealm] Realm used in the Proxy-Authenticate header. By default it's `Proxy`.
     * @param [options.verbose] If true, the server logs
     */
    constructor(options) {
        super();

        options = options || {};

        this.port = options.port || DEFAULT_PROXY_SERVER_PORT;
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

    log(str) {
        if (this.verbose) console.log(`Server[${this.port}]: ${str}`);
    }

    onClientError(err, socket) {
        this.log(`onClientError: ${err}`);
        this.sendResponse(socket, 400, null, 'Invalid request');
    }

    /**
     * Handles normal HTTP request by forwarding it to target host or the upstream proxy.
     */
    onRequest(request, response) {
        this.log(`${request.method} ${request.url} HTTP/${request.httpVersion}`);

        // console.log("MAIN REQUEST");
        // console.dir(_.pick(request, 'headers', 'url', 'method', 'httpVersion'));

        this.prepareRequestHandling(request)
            .then((handlerOpts) => {
                handlerOpts.srcResponse = response;
                const handler = new HandlerForward(handlerOpts);
                this.handlerRun(handler);
            })
            .catch((err) => {
                this.failRequest(request, err);
            });
    }

    /**
     * Handles HTTP CONNECT request by setting up a tunnel either to target host or to the upstream proxy.
     * @param request
     * @param head
     */
    onConnect(request) {
        this.log(`${request.method} ${request.url} HTTP/${request.httpVersion}`);
        // console.dir(request.headers);

        this.prepareRequestHandling(request)
            .then((handlerOpts) => {
                const handler = handlerOpts.upstreamProxyUrl
                    ? new HandlerTunnelChain(handlerOpts)
                    : new HandlerTunnelDirect(handlerOpts);
                this.handlerRun(handler);
            })
            .catch((err) => {
                this.failRequest(request, err);
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

        const result = {
            id: ++this.lastHandlerId,
            srcRequest: request,
            trgParsed: null,
            upstreamProxyUrl: null,
            verbose: this.verbose,
        };

        const socket = request.socket;
        let isHttp = false;

        return Promise.resolve()
            .then(() => {
                // Determine target hostname and port
                if (request.method === 'CONNECT') {
                    // The request should look like:
                    //   CONNECT server.example.com:80 HTTP/1.1
                    // Note that request.url contains the "server.example.com:80" part
                    result.trgParsed = parseHostHeader(request.url);
                    this.stats.connectRequestCount++;
                } else {
                    // The request should look like:
                    //   GET http://server.example.com:80/some-path HTTP/1.1
                    // Note that RFC 7230 says:
                    // "When making a request to a proxy, other than a CONNECT or server-wide
                    //  OPTIONS request (as detailed below), a client MUST send the target
                    //  URI in absolute-form as the request-target"
                    const parsed = url.parse(request.url);

                    // If srcRequest.url is something like '/some-path', this is most likely a normal HTTP request
                    if (!parsed.protocol) {
                        throw new RequestError('Hey, good try, but I\'m a proxy, not your ordinary HTTP server!', 400);
                    }
                    // Only HTTP is supported, other protocols such as HTTP or FTP must use the CONNECT method
                    if (parsed.protocol !== 'http:') {
                        throw new RequestError(`Only HTTP protocol is supported (was ${requestOptions.protocol})`, 400);
                    }

                    result.trgParsed = parsed;
                    isHttp = true;

                    this.stats.httpRequestCount++;
                }
                result.trgParsed.port = result.trgParsed.port || DEFAULT_TARGET_PORT;

                // Authenticate the request using a user function (if provided)
                if (!this.prepareRequestFunction) return { requestAuthentication: false, upstreamProxyUrl: null };

                // Pause the socket so that no data is lost
                socket.pause();

                const funcOpts = {
                    request,
                    username: null,
                    password: null,
                    hostname: result.trgParsed.hostname,
                    port: result.trgParsed.port,
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
                    const headers = { 'Proxy-Authenticate': `Basic realm="${this.authRealm}"` };
                    throw new RequestError('Credentials required.', 407, headers);
                }

                if (funcResult && funcResult.upstreamProxyUrl) {
                    result.upstreamProxyUrl = funcResult.upstreamProxyUrl;
                }

                return result;
            })
            .finally(() => {
                if (this.prepareRequestFunction) socket.resume();
            });
    }

    handlerRun(handler) {
        this.handlers[handler.id] = handler;
        handler.once('destroy', () => {
            delete this.handlers[handler.id];
        });
        handler.run();
    }

    /**
     * Sends a HTTP error response to the client.
     * @param request
     * @param err
     */
    failRequest(request, err) {
        if (err.name === REQUEST_ERROR_NAME) {
            this.log(`Request failed (status ${err.statusCode}): ${err.message}`);
            this.sendResponse(request.socket, err.statusCode, err.headers, err.message);
        } else {
            this.log(`Request failed with unknown error: ${err.stack || err}`);
            this.sendResponse(request.socket, 500, null, 'Internal error in proxy server');
            this.emit('requestFailed', err);
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
            let msg = `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\n`;
            _.each(headers, (value, key) => {
                msg += `${key}: ${value}\r\n`;
            });
            msg += `\r\n${message}`;

            socket.write(msg, () => {
                socket.end();

                // Unfortunately calling end() will not close the socket
                // if client refuses to close it. Hence calling destroy after a short while.
                setTimeout(() => {
                    socket.destroy();
                }, 100);
            });
        } catch (err) {
            this.log(`Unhandled error in sendResponse(), will be ignored: ${err.stack || err}`);
        }
    }


    /**
     * Starts listening at a port specified in the constructor.
     * @param callback Optional callback
     * @return {*}
     */
    listen(callback) {
        return Promise.promisify(this.server.listen.bind(this.server))(this.port)
            .then(() => {
                this.log('Listening...');
            })
            .catch((err) => {
                this.log(`Listen failed: ${err}`);
                throw err;
            })
            .nodeify(callback);
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
            this.log('Destroying pending handlers');
            let count = 0;
            _.each(this.handlers, (handler) => {
                count++;
                handler.destroy();
            });
            this.log(`Destroyed ${count} pending handlers`);
        }

        // TODO: keep track of all handlers and close them if closeConnections=true
        if (this.server) {
            const server = this.server;
            this.server = null;
            return Promise.promisify(server.close).bind(server)().nodeify(callback);
        }
    }
}
