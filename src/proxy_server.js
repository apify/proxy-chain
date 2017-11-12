import http from 'http';
import url from 'url';
import _ from 'underscore';

import { parseHostHeader, parseProxyAuthorizationHeader } from './tools';
import Promise from 'bluebird';
import HandlerForward from './handler_forward';
import HandlerTunnelDirect from './handler_tunnel_direct';
import HandlerTunnelChain from './handler_tunnel_chain';

// TODO: Implement this requirement from rfc7230
// A proxy MUST forward unrecognized header fields unless the field-name
// is listed in the Connection header field (Section 6.1) or the proxy
// is specifically configured to block, or otherwise transform, such
// fields.  Other recipients SHOULD ignore unrecognized header fields.
// These requirements allow HTTP's functionality to be enhanced without
// requiring prior update of deployed intermediaries.

const DEFAULT_AUTH_REALM = 'Proxy';
const DEFAULT_PROXY_SERVER_PORT = 8000;
const DEFAULT_TARGET_PORT = 80;

const REQUEST_ERROR_NAME = 'RequestError';

export class RequestError extends Error {
    constructor(message, statusCode, headers) {
        super(message);
        this.name = REQUEST_ERROR_NAME;
        this.statusCode = statusCode;
        this.headers = headers;

        Error.captureStackTrace(this, RequestError);
    }
}


export class ProxyServer {
    /**
     * Initializes a new instance of ProxyServer class.
     * @param options
     * @param [options.port] Port where the server the server will listen. By default 8000.
     * @param [options.authFunction] Custom function to authenticate proxy requests.
     * It accepts a single parameter which is an object:
     * `{ request: Object, username: String, password: String }`
     * and returns a promise resolving to a Boolean value.
     * If `authFunction` is not set, the proxy server will not require any authentication.
     * @param [options.authRealm] Realm used in the Proxy-Authenticate header. By default it's `Proxy`.
     * @param [options.proxyChainUrlFunction] Custom function that provides the proxy to chain to.
     * It accepts a single parameter which is an object:
     * `{ request: Object, username: String, password: String, hostname: String, port: Number, isHttp: Boolean }`
     * and returns a promise resolving to a String value with the chained proxy URL.
     * If the result is false-ish value, the request will be proxied directly to the target host.
     * @param [options.verbose] If true, the server logs
     */
    constructor(options) {
        options = options || {};

        this.port = options.port || DEFAULT_PROXY_SERVER_PORT;
        this.authFunction = options.authFunction;
        this.authRealm = options.authRealm || DEFAULT_AUTH_REALM;
        this.proxyChainUrlFunction = options.proxyChainUrlFunction;
        this.verbose = !!options.verbose;

        this.server = http.createServer();
        this.server.on('clientError', this.onClientError.bind(this));
        this.server.on('request', this.onRequest.bind(this));
        this.server.on('connect', this.onConnect.bind(this));
    }

    log(str, force) {
        if (this.verbose || force) console.log(`ProxyServer[${this.port}]: ${str}`)
    }

    onClientError(err, socket) {
        this.log(`onClientError: ${err}`);
        this.sendResponse(socket, 400, null, 'Invalid request');
    }

    /**
     * Handles normal HTTP request by forwarding it to target host or the chained proxy.
     */
    onRequest(request, response) {
        this.log(`${request.method} ${request.url} HTTP/${request.httpVersion}`);

        //console.log("MAIN REQUEST");
        //console.dir(_.pick(request, 'headers', 'url', 'method', 'httpVersion'));

        this.prepareRequestHandling(request)
            .then((handlerOpts) => {
                handlerOpts.srcResponse = response;
                const handler = new HandlerForward(handlerOpts);
                handler.run();
            })
            .catch((err) => {
                this.failRequest(request, err);
            });
    }

    /**
     * Handles HTTP CONNECT request by setting up a tunnel either to target host or to the chained proxy.
     * @param request
     * @param socket
     * @param head
     */
    onConnect(request, socket, head) {
        this.log(`${request.method} ${request.url} HTTP/${request.httpVersion}`);
        //console.dir(request.headers);

        this.prepareRequestHandling(request)
            .then((handlerOpts) => {
                const handler = handlerOpts.proxyChainUrl
                    ? new HandlerTunnelChain(handlerOpts)
                    : new HandlerTunnelDirect(handlerOpts);
                handler.run();
            })
            .catch((err) => {
                this.failRequest(request, err);
            });
    }


    /**
     * Authenticates a new request and determines proxy chain URL using the user functions.
     * Returns a promise resolving to an object that can be passed to construcot of one of the HandlerXxx classes.
     * @param request
     */
    prepareRequestHandling(request) {
        //console.log('XXX prepareRequestHandling');
        //console.dir(_.pick(request, 'url', 'method'));
        //console.dir(url.parse(request.url));

        let result = {
            srcRequest: request,
            trgParsed: null,
            proxyChainUrl: null,
            verbose: this.verbose,
        };

        const socket = request.socket;
        let paused = false;
        let isHttp = false;
        let username = null;
        let password = null;

        return Promise.resolve()
            .then(() => {
                // Determine target hostname and port
                if (request.method === 'CONNECT') {
                    // The request should look like:
                    //   CONNECT server.example.com:80 HTTP/1.1
                    // Note that request.url contains the "server.example.com:80" part
                    result.trgParsed = parseHostHeader(request.url);
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
                }
                result.trgParsed.port = result.trgParsed.port || DEFAULT_TARGET_PORT;

                // Authenticate the request using the provided authFunction (if provided)
                if (!this.authFunction) return null;

                // Pause the socket so that no data is lost
                socket.pause();
                paused = true;

                const authFuncOpts = {
                    request,
                    username: null,
                    password: null,
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

                    authFuncOpts.username = username = auth.username;
                    authFuncOpts.password = password = auth.password
                }

                return this.authFunction(authFuncOpts)
                    .then((isAuthenticated) => {
                        // If not authenticated, request client to authenticate
                        if (!isAuthenticated) {
                            const headers = { 'Proxy-Authenticate': `Basic realm="${this.authRealm}"` };
                            throw new RequestError('Credential required.', 407, headers);
                        }
                    });
            })
            .then(() => {
                // Obtain URL to chained proxy using the provided proxyChainUrlFunction (if provided)
                if (!this.proxyChainUrlFunction) return result;

                if (!paused) {
                    socket.pause();
                    paused = true;
                }

                const funcOpts = {
                    request,
                    username,
                    password,
                    hostname: result.trgParsed.hostname,
                    port: result.trgParsed.port,
                    isHttp,
                };
                return this.proxyChainUrlFunction(funcOpts)
                    .then((proxyChainUrl) => {
                        // console.log("proxyChainUrl: " + proxyChainUrl);
                        result.proxyChainUrl = proxyChainUrl;
                        return result;
                    });
            })
            .finally(() => {
                if (paused) socket.resume();
            });
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
            this.log(`Request failed with unknown error: ${err.stack || err}`, true);
            this.sendResponse(request.socket, 500, null, 'Internal server error');
        }
    }

    /**
     * Sends a simple HTTP response to the client.
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

            socket.end(msg);
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

    close(keepConnections, callback) {
        // TODO: keep track of all handlers and close them if closeConnections=true
        if (this.server) {
            const server = this.server;
            this.server = null;
            return Promise.promisify(server.close).bind(server)().nodeify(callback);
        }
    }
}