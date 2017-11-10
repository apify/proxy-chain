import http from 'http';
import _ from 'underscore';
import { parseHostHeader, parseProxyAuthorizationHeader } from './tools';
import Promise from 'bluebird';
import HandlerForward from './handler_forward';
import HandlerTunnelDirect from './handler_tunnel_direct';
import HandlerTunnelChain from './handler_tunnel_chain';

const DEFAULT_AUTH_REALM = 'Proxy';
const DEFAULT_PROXY_SERVER_PORT = 8000;

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
     * It accepts a single parameter which is an object `{ request: Object, username: String, password: String }`
     * and returns a promise resolving to a Boolean value.
     * If `authFunction` is not set, the proxy server will not require any authentication.
     * @param [options.authRealm] Realm used in the Proxy-Authenticate header. By default it's `Proxy`.
     * @param [options.proxyChainUrlFunction] Custom function that provides the proxy to chain to.
     * It accepts a single parameter which is an object `{ request: Object, username: String, host: String, port: Number, protocol: String }`
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
        let result = {
            srcRequest: request,
            trgHost: null,
            trgPort: null,
            proxyChainUrl: null,
            verbose: this.verbose,
        };

        const socket = request.socket;
        let paused = false;
        let username = null;

        return Promise.resolve()
            .then(() => {
                // First, parse Host header
                const parsedHost = parseHostHeader(request.headers['host']);
                if (!parsedHost || !parsedHost.host) {
                    throw new RequestError('Invalid "Host" header', 400);
                }
                result.trgHost = parsedHost.host;
                result.trgPort = parsedHost.port;

                // Second, authenticate the request using the provided authFunction
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
                    authFuncOpts.password = auth.password
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
                // Third, obtain URL to chained proxy using the provided proxyChainUrlFunction
                if (!this.proxyChainUrlFunction) return result;

                if (!paused) {
                    socket.pause();
                    paused = true;
                }

                const funcOpts = {
                    request,
                    username,
                    host: result.trgHost,
                    port: result.trgPort,
                    protocol: 'TODO',
                };
                return this.proxyChainUrlFunction(funcOpts)
                    .then((proxyChainUrl) => {
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