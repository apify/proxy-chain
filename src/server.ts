/* eslint-disable no-use-before-define */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type dns from 'node:dns';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type net from 'node:net';
import { URL } from 'node:url';
import util from 'node:util';

import type { HandlerOpts as ChainOpts } from './chain';
import { chain } from './chain';
import { chainSocks } from './chain_socks';
import { customConnect } from './custom_connect';
import type { HandlerOpts as CustomResponseOpts } from './custom_response';
import { handleCustomResponse } from './custom_response';
import { direct } from './direct';
import type { HandlerOpts as ForwardOpts } from './forward';
import { forward } from './forward';
import { forwardSocks } from './forward_socks';
import { RequestError } from './request_error';
import type { Socket } from './socket';
import { badGatewayStatusCodes } from './statuses';
import { getTargetStats } from './utils/count_target_bytes';
import { nodeify } from './utils/nodeify';
import { normalizeUrlPort } from './utils/normalize_url_port';
import { parseAuthorizationHeader } from './utils/parse_authorization_header';
import { redactUrl } from './utils/redact_url';

export const SOCKS_PROTOCOLS = ['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'];

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

export type RequestStats = {
    /** Total bytes received from the client. */
    srcRxBytes: number,
    /** Total bytes sent to the client. */
    srcTxBytes: number,
    /** Total bytes received from the target. */
    trgRxBytes: number | null,
    /** Total bytes sent to the target. */
    trgTxBytes: number | null,
};

type HandlerOpts = {
    server: Server;
    id: number;
    requestId: string;
    startTime: number;
    srcRequest: http.IncomingMessage;
    srcResponse: http.ServerResponse | null;
    srcHead: Buffer | null;
    trgParsed: URL | null;
    upstreamProxyUrlParsed: URL | null;
    ignoreUpstreamProxyCertificate: boolean;
    isHttp: boolean;
    customResponseFunction?: CustomResponseOpts['customResponseFunction'] | null;
    customConnectServer?: http.Server | null;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
    customTag?: unknown;
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

export type RequestBypassedData = {
    id: string;
    request: http.IncomingMessage;
    connectionId: number;
    customTag?: unknown;
};

export type RequestFinishedData = RequestBypassedData & {
    stats: RequestStats;
    response?: http.IncomingMessage;
};

export type PrepareRequestFunctionResult = {
    customResponseFunction?: CustomResponseOpts['customResponseFunction'];
    customConnectServer?: http.Server | null;
    requestAuthentication?: boolean;
    failMsg?: string;
    upstreamProxyUrl?: string | null;
    ignoreUpstreamProxyCertificate?: boolean;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
    customTag?: unknown;
};

type Promisable<T> = T | Promise<T>;
export type PrepareRequestFunction = (opts: PrepareRequestFunctionOpts) => Promisable<undefined | PrepareRequestFunctionResult>;

/**
 * Represents the proxy server.
 *
 * It emits the `requestFailed` event on unexpected request errors, with the following parameter `{ error, request }`.
 * It emits the `connectionClosed` event when connection to proxy server is closed, with parameter `{ connectionId, stats }`.
 * It emits the `requestBypassed` event when a request is bypassed, with parameter `RequestBypassedData`.
 * It emits the `requestFinished` event when a request is finished, with parameter `RequestFinishedData`.
 */
export class Server extends EventEmitter {
    port: number;

    host?: string;

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
        host?: string,
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

        this.host = options.host;
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
            const logPrefix = connectionId != null ? `${String(connectionId)} | ` : '';
            // eslint-disable-next-line no-console
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
        // We have to manually destroy the socket if it timeouts.
        // This will prevent connections from leaking and close them properly.
        socket.on('timeout', () => {
            socket.destroy();
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
            return new RequestError('Invalid colon in username in upstream proxy credentials', badGatewayStatusCodes.AUTH_FAILED);
        }

        if (error.message === '407 Proxy Authentication Required') {
            return new RequestError('Invalid upstream proxy credentials', badGatewayStatusCodes.AUTH_FAILED);
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
                this.log(proxyChainId, 'Using handleCustomResponse()');
                await handleCustomResponse(request, response, handlerOpts as CustomResponseOpts);
                this.emit('requestBypassed', {
                    id: handlerOpts.requestId,
                    request,
                    connectionId: handlerOpts.id,
                    customTag: handlerOpts.customTag,
                });
                return;
            }

            if (handlerOpts.upstreamProxyUrlParsed && SOCKS_PROTOCOLS.includes(handlerOpts.upstreamProxyUrlParsed.protocol)) {
                this.log(proxyChainId, 'Using forwardSocks()');
                await forwardSocks(request, response, handlerOpts as ForwardOpts);
                return;
            }

            this.log(proxyChainId, 'Using forward()');
            await forward(request, response, handlerOpts as ForwardOpts);
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

            if (handlerOpts.customConnectServer) {
                socket.unshift(head); // See chain.ts for why we do this
                await customConnect(socket, handlerOpts.customConnectServer);
                this.emit('requestBypassed', {
                    id: handlerOpts.requestId,
                    request,
                    connectionId: handlerOpts.id,
                    customTag: handlerOpts.customTag,
                });
                return;
            }

            if (handlerOpts.upstreamProxyUrlParsed) {
                if (SOCKS_PROTOCOLS.includes(handlerOpts.upstreamProxyUrlParsed.protocol)) {
                    this.log(socket.proxyChainId, `Using chainSocks() => ${request.url}`);
                    await chainSocks(data);
                    return;
                }
                this.log(socket.proxyChainId, `Using chain() => ${request.url}`);
                chain(data);
                return;
            }

            this.log(socket.proxyChainId, `Using direct() => ${request.url}`);
            direct(data);
        } catch (error) {
            this.failRequest(request, this.normalizeHandlerError(error as NodeJS.ErrnoException));
        }
    }

    /**
     * Prepares handler options from a request.
     * @see {prepareRequestHandling}
     */
    getHandlerOpts(request: http.IncomingMessage): HandlerOpts {
        const requestId = randomUUID();
        // Casing does not matter, but we do it to avoid breaking changes.
        request.headers['request-id'] = requestId;

        const handlerOpts: HandlerOpts = {
            server: this,
            id: (request.socket as Socket).proxyChainId!,
            requestId,
            startTime: Date.now(),
            srcRequest: request,
            srcHead: null,
            trgParsed: null,
            upstreamProxyUrlParsed: null,
            ignoreUpstreamProxyCertificate: false,
            isHttp: false,
            srcResponse: null,
            customResponseFunction: null,
            customConnectServer: null,
        };

        this.log((request.socket as Socket).proxyChainId, `!!! Handling ${request.method} ${request.url} HTTP/${request.httpVersion}`);

        if (request.method === 'CONNECT') {
            // CONNECT server.example.com:80 HTTP/1.1
            try {
                handlerOpts.trgParsed = new URL(`connect://${request.url}`);
            } catch {
                throw new RequestError(`Target "${request.url}" could not be parsed`, 400);
            }

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
            } catch {
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

            // Authenticate the request using a user function (if provided)
            const proxyAuth = request.headers['proxy-authorization'];
            if (proxyAuth) {
                const auth = parseAuthorizationHeader(proxyAuth);

                if (!auth) {
                    throw new RequestError('Invalid "Proxy-Authorization" header', 400);
                }

                // https://datatracker.ietf.org/doc/html/rfc7617#page-3
                // Note that both scheme and parameter names are matched case-
                // insensitively.
                if (auth.type.toLowerCase() !== 'basic') {
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
        handlerOpts.customConnectServer = funcResult.customConnectServer;
        handlerOpts.customTag = funcResult.customTag;

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

            if (!['http:', 'https:', ...SOCKS_PROTOCOLS].includes(handlerOpts.upstreamProxyUrlParsed.protocol)) {
                throw new Error(`Invalid "upstreamProxyUrl" provided: URL must have one of the following protocols: "http", "https", ${SOCKS_PROTOCOLS.map((p) => `"${p.replace(':', '')}"`).join(', ')} (was "${funcResult.upstreamProxyUrl}")`);
            }
        }

        if (funcResult.ignoreUpstreamProxyCertificate !== undefined) {
            handlerOpts.ignoreUpstreamProxyCertificate = funcResult.ignoreUpstreamProxyCertificate;
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
        this.emit('requestFailed', {
            request,
            error,
        });

        const { srcResponse } = (request as any).handlerOpts as HandlerOpts;

        if (!request.socket) {
            return;
        }

        if (request.socket.destroyed) {
            return;
        }

        // If the request was not handled yet, we need to close the socket.
        // The client will get an empty response.
        if (srcResponse && !srcResponse.headersSent) {
            // We need to wait for the client to send the full request, otherwise it may get ECONNRESET.
            // This is particularly important for HTTP CONNECT, because the client sends the first data packet
            // along with the request headers.
            request.on('end', () => request.socket.end());
            // If the client never sends the full request, the socket will timeout and close.
            request.resume();
        }
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
     */
    async listen(callback?: (error: NodeJS.ErrnoException | null) => void): Promise<void> {
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
            this.server.listen(this.port, this.host);
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
     * Returns the statistics of a specific connection.
     * @param connectionId The ID of the connection.
     * @returns The statistics object, or undefined if the connection does not exist.
     */
    getConnectionStats(connectionId: number): ConnectionStats | undefined {
        const socket = this.connections.get(connectionId);

        if (!socket) return;

        const { bytesWritten, bytesRead } = getTargetStats(socket);

        return {
            srcTxBytes: socket.bytesWritten,
            srcRxBytes: socket.bytesRead,
            trgTxBytes: bytesWritten,
            trgRxBytes: bytesRead,
        };
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

        this.log(null, `Destroyed ${this.connections.size} pending sockets`);
    }

    /**
     * Closes the proxy server.
     * @param closeConnections If true, pending proxy connections are forcibly closed.
     */
    async close(closeConnections: boolean, callback?: (error: NodeJS.ErrnoException | null) => void): Promise<void> {
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
