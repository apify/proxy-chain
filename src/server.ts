import net from 'net';
import dns from 'dns';
import http from 'http';
import util from 'util';
import { URL } from 'url';
import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import { parseAuthorizationHeader } from './utils/parse_authorization_header';
import { redactUrl } from './utils/redact_url';
import { nodeify } from './utils/nodeify';
import { getTargetStats } from './utils/count_target_bytes';
import { RequestError } from './request_error';
import { chain, HandlerOpts as ChainOpts } from './chain';
import { forward, HandlerOpts as ForwardOpts } from './forward';
import { direct } from './direct';
import { handleCustomResponse, HandlerOpts as CustomResponseOpts } from './custom_response';
import { Socket } from './socket';
import { normalizeUrlPort } from './utils/normalize_url_port';

// TODO:
// - Implement this requirement from rfc7230
//   "A proxy MUST forward unrecognized header fields unless the field-name
//    is listed in the Connection header field (Section 6.1) or the proxy
//    is specifically configured to block, or otherwise transform, such
//    fields.  Other recipients SHOULD ignore unrecognized header fields.
//    These requirements allow HTTP's functionality to be enhanced without
//    requiring prior update of deployed intermediaries."

const DEFAULT_AUTH_REALM = 'ProxyChain';
const DEFAULT_PROXY_SERVER_PORT = 8000;

export type ConnectionStats = {
    srcTxBytes: number;
    srcRxBytes: number;
    trgTxBytes: number | null;
    trgRxBytes: number | null;
};

type HandlerOpts = {
    server: Server;
    id: number;
    srcRequest: http.IncomingMessage;
    srcResponse: http.ServerResponse | null;
    srcHead: Buffer | null;
    trgParsed: URL | null;
    upstreamProxyUrlParsed: URL | null;
    isHttp: boolean;
    customResponseFunction: CustomResponseOpts['customResponseFunction'] | null;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
};

export type PrepareRequestFunctionOpts = {
    connectionId: number;
    request: http.IncomingMessage;
    username: string;
    password: string;
    hostname: string;
    port: number;
    isHttp: boolean;
};

export type PrepareRequestFunctionResult = {
    customResponseFunction?: CustomResponseOpts['customResponseFunction'];
    requestAuthentication?: boolean;
    failMsg?: string;
    upstreamProxyUrl?: string | null;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
};

type Promisable<T> = T | Promise<T>;
export type PrepareRequestFunction = (opts: PrepareRequestFunctionOpts) => Promisable<undefined | PrepareRequestFunctionResult>;

/**
 * Represents the proxy server.
 * It emits the 'requestFailed' event on unexpected request errors, with the following parameter `{ error, request }`.
 * It emits the 'connectionClosed' event when connection to proxy server is closed, with parameter `{ connectionId, stats }`.
 */
export class Server extends EventEmitter {
    port: number;

    prepareRequestFunction?: PrepareRequestFunction;

    authRealm: unknown;

    verbose: boolean;

    server: http.Server;

    lastHandlerId: number;

    stats: { httpRequestCount: number; connectRequestCount: number; };

    connections: Map<number, Socket>;

    /**
     * Initializes a new instance of Server class.
     * @param options
     * @param [options.port] Port where the server will listen. By default 8000.
     * @param [options.prepareRequestFunction] Custom function to authenticate proxy requests,
     * provide URL to upstream proxy or potentially provide a function that generates a custom response to HTTP requests.
     * It accepts a single parameter which is an object:
     * ```
     * {
     *   connectionId: symbol,
     *   request: http.IncomingMessage,
     *   username: string,
     *   password: string,
     *   hostname: string,
     *   port: number,
     *   isHttp: boolean,
     * }
     * ```
     * and returns an object (or promise resolving to the object) with following form:
     * ```
     * {
     *   requestAuthentication: boolean,
     *   upstreamProxyUrl: string,
     *   customResponseFunction: Function,
     * }
     * ```
     * If `upstreamProxyUrl` is a falsy value, no upstream proxy is used.
     * If `prepareRequestFunction` is not set, the proxy server will not require any authentication
     * and will not use any upstream proxy.
     * If `customResponseFunction` is set, it will be called to generate a custom response to the HTTP request.
     * It should not be used together with `upstreamProxyUrl`.
     * @param [options.authRealm] Realm used in the Proxy-Authenticate header and also in the 'Server' HTTP header. By default it's `ProxyChain`.
     * @param [options.verbose] If true, the server will output logs
     */
    constructor(options: {
        port?: number,
        prepareRequestFunction?: PrepareRequestFunction,
        verbose?: boolean,
        authRealm?: unknown,
    } = {}) {
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

    log(connectionId: unknown, str: string): void {
        if (this.verbose) {
            const logPrefix = connectionId ? `${String(connectionId)} | ` : '';
            console.log(`ProxyServer[${this.port}]: ${logPrefix}${str}`);
        }
    }

    onClientError(err: NodeJS.ErrnoException, socket: Socket): void {
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
     */
    registerConnection(socket: Socket): void {
        const unique = this.lastHandlerId++;

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
    onConnection(socket: Socket): void {
        // https://github.com/nodejs/node/issues/23858
        if (!socket.remoteAddress) {
            socket.destroy();
            return;
        }

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

    /**
     * Converts known errors to be instance of RequestError.
     */
    normalizeHandlerError(error: NodeJS.ErrnoException): NodeJS.ErrnoException {
        if (error.message === 'Username contains an invalid colon') {
            return new RequestError('Invalid colon in username in upstream proxy credentials', 502);
        }

        if (error.message === '407 Proxy Authentication Required') {
            return new RequestError('Invalid upstream proxy credentials', 502);
        }

        if (error.code === 'ENOTFOUND') {
            if ((error as any).proxy) {
                return new RequestError('Failed to connect to upstream proxy', 502);
            }

            return new RequestError('Target website does not exist', 404);
        }

        return error;
    }

    /**
     * Handles normal HTTP request by forwarding it to target host or the upstream proxy.
     */
    async onRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        try {
            const handlerOpts = await this.prepareRequestHandling(request);
            handlerOpts.srcResponse = response;

            const { proxyChainId } = request.socket as Socket;

            if (handlerOpts.customResponseFunction) {
                this.log(proxyChainId, 'Using HandlerCustomResponse');
                return await handleCustomResponse(request, response, handlerOpts as CustomResponseOpts);
            }

            this.log(proxyChainId, 'Using forward');
            return await forward(request, response, handlerOpts as ForwardOpts);
        } catch (error) {
            this.failRequest(request, this.normalizeHandlerError(error as NodeJS.ErrnoException));
        }
    }

    /**
     * Handles HTTP CONNECT request by setting up a tunnel either to target host or to the upstream proxy.
     * @param request
     * @param socket
     * @param head The first packet of the tunneling stream (may be empty)
     */
    async onConnect(request: http.IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
        try {
            const handlerOpts = await this.prepareRequestHandling(request);
            handlerOpts.srcHead = head;

            const data = { request, sourceSocket: socket, head, handlerOpts: handlerOpts as ChainOpts, server: this, isPlain: false };

            if (handlerOpts.upstreamProxyUrlParsed) {
                this.log(socket.proxyChainId, `Using HandlerTunnelChain => ${request.url}`);
                return await chain(data);
            }

            this.log(socket.proxyChainId, `Using HandlerTunnelDirect => ${request.url}`);
            return await direct(data);
        } catch (error) {
            this.failRequest(request, this.normalizeHandlerError(error as NodeJS.ErrnoException));
        }
    }

    /**
     * Prepares handler options from a request.
     * @see {prepareRequestHandling}
     */
    getHandlerOpts(request: http.IncomingMessage): HandlerOpts {
        const handlerOpts: HandlerOpts = {
            server: this,
            id: (request.socket as Socket).proxyChainId!,
            srcRequest: request,
            srcHead: null,
            trgParsed: null,
            upstreamProxyUrlParsed: null,
            isHttp: false,
            srcResponse: null,
            customResponseFunction: null,
        };

        this.log((request.socket as Socket).proxyChainId, `!!! Handling ${request.method} ${request.url} HTTP/${request.httpVersion}`);

        if (request.method === 'CONNECT') {
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
                parsed = new URL(request.url!);
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
    async callPrepareRequestFunction(request: http.IncomingMessage, handlerOpts: HandlerOpts): Promise<PrepareRequestFunctionResult> {
        // Authenticate the request using a user function (if provided)
        if (this.prepareRequestFunction) {
            const funcOpts: PrepareRequestFunctionOpts = {
                connectionId: (request.socket as Socket).proxyChainId!,
                request,
                username: '',
                password: '',
                hostname: handlerOpts.trgParsed!.hostname,
                port: normalizeUrlPort(handlerOpts.trgParsed!),
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

                funcOpts.username = auth.username!;
                funcOpts.password = auth.password!;
            }

            const result = await this.prepareRequestFunction(funcOpts);
            return result ?? {};
        }

        return {};
    }

    /**
     * Authenticates a new request and determines upstream proxy URL using the user function.
     * Returns a promise resolving to an object that can be used to run a handler.
     * @param request
     */
    async prepareRequestHandling(request: http.IncomingMessage): Promise<HandlerOpts> {
        const handlerOpts = this.getHandlerOpts(request);
        const funcResult = await this.callPrepareRequestFunction(request, handlerOpts);

        handlerOpts.localAddress = funcResult.localAddress;
        handlerOpts.ipFamily = funcResult.ipFamily;
        handlerOpts.dnsLookup = funcResult.dnsLookup;

        // If not authenticated, request client to authenticate
        if (funcResult.requestAuthentication) {
            throw new RequestError(funcResult.failMsg || 'Proxy credentials required.', 407);
        }

        if (funcResult.upstreamProxyUrl) {
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

        const { proxyChainId } = request.socket as Socket;

        if (funcResult.customResponseFunction) {
            this.log(proxyChainId, 'Using custom response function');

            handlerOpts.customResponseFunction = funcResult.customResponseFunction;

            if (!handlerOpts.isHttp) {
                throw new Error('The "customResponseFunction" option can only be used for HTTP requests.');
            }

            if (typeof (handlerOpts.customResponseFunction) !== 'function') {
                throw new Error('The "customResponseFunction" option must be a function.');
            }
        }

        if (handlerOpts.upstreamProxyUrlParsed) {
            this.log(proxyChainId, `Using upstream proxy ${redactUrl(handlerOpts.upstreamProxyUrlParsed)}`);
        }

        return handlerOpts;
    }

    /**
     * Sends a HTTP error response to the client.
     * @param request
     * @param error
     */
    failRequest(request: http.IncomingMessage, error: NodeJS.ErrnoException): void {
        const { proxyChainId } = request.socket as Socket;

        if (error.name === 'RequestError') {
            const typedError = error as RequestError;

            this.log(proxyChainId, `Request failed (status ${typedError.statusCode}): ${error.message}`);
            this.sendSocketResponse(request.socket, typedError.statusCode, typedError.headers, error.message);
        } else {
            this.log(proxyChainId, `Request failed with error: ${error.stack || error}`);
            this.sendSocketResponse(request.socket, 500, {}, 'Internal error in proxy server');
            this.emit('requestFailed', { error, request });
        }

        // Emit 'connectionClosed' event if request failed and connection was already reported
        this.log(proxyChainId, 'Closed because request failed with error');
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
    sendSocketResponse(socket: Socket, statusCode = 500, caseSensitiveHeaders = {}, message = ''): void {
        try {
            const headers = Object.fromEntries(
                Object.entries(caseSensitiveHeaders).map(
                    ([name, value]) => [name.toLowerCase(), value],
                ),
            );

            headers.connection = 'close';
            headers.date = (new Date()).toUTCString();
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
            this.log(socket.proxyChainId, `Unhandled error in sendResponse(), will be ignored: ${(err as Error).stack || err}`);
        }
    }

    /**
     * Starts listening at a port specified in the constructor.
     * @param callback Optional callback
     * @return {(Promise|undefined)}
     */
    listen(callback?: (error: NodeJS.ErrnoException | null) => void): Promise<void> {
        const promise = new Promise<void>((resolve, reject) => {
            // Unfortunately server.listen() is not a normal function that fails on error,
            // so we need this trickery
            const onError = (error: NodeJS.ErrnoException) => {
                this.log(null, `Listen failed: ${error}`);
                removeListeners();
                reject(error);
            };
            const onListening = () => {
                this.port = (this.server.address() as net.AddressInfo).port;
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
     */
    getConnectionIds(): number[] {
        return [...this.connections.keys()];
    }

    /**
     * Gets data transfer statistics of a specific proxy connection.
     */
    getConnectionStats(connectionId: number): ConnectionStats | undefined {
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
     * Forcibly close a specific pending proxy connection.
     */
    closeConnection(connectionId: number): void {
        this.log(null, 'Closing pending socket');

        const socket = this.connections.get(connectionId);
        if (!socket) return;

        socket.destroy();

        this.log(null, `Destroyed pending socket`);
    }

    /**
     * Forcibly closes pending proxy connections.
     */
    closeConnections(): void {
        this.log(null, 'Closing pending sockets');

        for (const socket of this.connections.values()) {
            socket.destroy();
        }

        this.connections.clear();

        this.log(null, `Destroyed ${this.connections.size} pending sockets`);
    }

    /**
     * Closes the proxy server.
     * @param closeConnections If true, pending proxy connections are forcibly closed.
     */
    close(closeConnections: boolean, callback?: (error: NodeJS.ErrnoException | null) => void): Promise<void> {
        if (typeof closeConnections === 'function') {
            callback = closeConnections;
            closeConnections = false;
        }

        if (closeConnections) {
            this.closeConnections();
        }

        if (this.server) {
            const { server } = this;
            // @ts-expect-error Let's make sure we can't access the server anymore.
            this.server = null;
            const promise = util.promisify(server.close).bind(server)();
            return nodeify(promise, callback);
        }

        return nodeify(Promise.resolve(), callback);
    }
}
