/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import { Buffer } from 'node:buffer';
import type dns from 'node:dns';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { URL } from 'node:url';
import type { HandlerOpts as CustomResponseOpts } from './custom_response';
import type { Socket } from './socket';
export declare const SOCKS_PROTOCOLS: string[];
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
 * It emits the 'requestFailed' event on unexpected request errors, with the following parameter `{ error, request }`.
 * It emits the 'connectionClosed' event when connection to proxy server is closed, with parameter `{ connectionId, stats }`.
 */
export declare class Server extends EventEmitter {
    port: number;
    host?: string;
    prepareRequestFunction?: PrepareRequestFunction;
    authRealm: unknown;
    verbose: boolean;
    server: http.Server;
    lastHandlerId: number;
    stats: {
        httpRequestCount: number;
        connectRequestCount: number;
        trafficUsedInBytes: number;
    };
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
    constructor(options?: {
        port?: number;
        host?: string;
        prepareRequestFunction?: PrepareRequestFunction;
        verbose?: boolean;
        authRealm?: unknown;
    });
    log(connectionId: unknown, str: string): void;
    onClientError(err: NodeJS.ErrnoException, socket: Socket): void;
    /**
     * Assigns a unique ID to the socket and keeps the register up to date.
     * Needed for abrupt close of the server.
     */
    registerConnection(socket: Socket): void;
    /**
     * Registering total stats each server
     */
    /**
     * Handles incoming sockets, useful for error handling
     */
    onConnection(socket: Socket): void;
    /**
     * Converts known errors to be instance of RequestError.
     */
    normalizeHandlerError(error: NodeJS.ErrnoException): NodeJS.ErrnoException;
    /**
     * Handles normal HTTP request by forwarding it to target host or the upstream proxy.
     */
    onRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
    /**
     * Handles HTTP CONNECT request by setting up a tunnel either to target host or to the upstream proxy.
     * @param request
     * @param socket
     * @param head The first packet of the tunneling stream (may be empty)
     */
    onConnect(request: http.IncomingMessage, socket: Socket, head: Buffer): Promise<void>;
    /**
     * Prepares handler options from a request.
     * @see {prepareRequestHandling}
     */
    getHandlerOpts(request: http.IncomingMessage): HandlerOpts;
    /**
     * Calls `this.prepareRequestFunction` with normalized options.
     * @param request
     * @param handlerOpts
     */
    callPrepareRequestFunction(request: http.IncomingMessage, handlerOpts: HandlerOpts): Promise<PrepareRequestFunctionResult>;
    /**
     * Authenticates a new request and determines upstream proxy URL using the user function.
     * Returns a promise resolving to an object that can be used to run a handler.
     * @param request
     */
    prepareRequestHandling(request: http.IncomingMessage): Promise<HandlerOpts>;
    /**
     * Sends a HTTP error response to the client.
     * @param request
     * @param error
     */
    failRequest(request: http.IncomingMessage, error: NodeJS.ErrnoException): void;
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
    sendSocketResponse(socket: Socket, statusCode?: number, caseSensitiveHeaders?: {}, message?: string): void;
    /**
     * Starts listening at a port specified in the constructor.
     */
    listen(callback?: (error: NodeJS.ErrnoException | null) => void): Promise<void>;
    /**
     * Gets array of IDs of all active connections.
     */
    getConnectionIds(): number[];
    /**
     * Gets data transfer statistics of a specific proxy connection.
     */
    getConnectionStats(connectionId: number): ConnectionStats | undefined;
    /**
     * Forcibly close a specific pending proxy connection.
     */
    closeConnection(connectionId: number): void;
    /**
     * Forcibly closes pending proxy connections.
     */
    closeConnections(): void;
    /**
     * Closes the proxy server.
     * @param closeConnections If true, pending proxy connections are forcibly closed.
     */
    close(closeConnections: boolean, callback?: (error: NodeJS.ErrnoException | null) => void): Promise<void>;
}
export {};
//# sourceMappingURL=server.d.ts.map