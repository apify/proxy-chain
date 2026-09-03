import { Buffer } from 'node:buffer';
import net from 'node:net';
import type { Readable } from 'node:stream';
import util from 'node:util';
import zlib from 'node:zlib';

import { Agent, Client, type Dispatcher, interceptors, ProxyAgent, request } from 'undici';

// Stateless, so it is shared by every request.
const REDIRECT_INTERCEPTOR = interceptors.redirect({ maxRedirections: 10 });

const gunzip = util.promisify(zlib.gunzip);

export type HttpRequestOpts = {
    url: string;
    method?: Dispatcher.HttpMethod;
    headers?: Record<string, string>;
    body?: string | Readable;
    /** Proxy to route through. Omit for a direct connection. */
    proxyUrl?: string;
    timeoutMillis?: number;
    /** Accepts self-signed certificates on the proxy and the target. */
    ignoreCertificateErrors?: boolean;
    /**
     * Reused instead of a throwaway one. Pass it when the socket must outlive the request.
     * It already encodes the connection, so the `ConnectionOpts` fields are ignored.
     */
    dispatcher?: Dispatcher;
};

export type ConnectionOpts = Pick<HttpRequestOpts, 'url' | 'proxyUrl' | 'timeoutMillis' | 'ignoreCertificateErrors'>;

export type HttpResponse = {
    statusCode: number;
    /** Repeating headers are joined with `, `. */
    headers: Record<string, string>;
    body: string;
};

const toBasicAuth = (username: string, password: string): string => {
    return `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString('base64')}`;
};

/**
 * Absolute request URI instead of a CONNECT tunnel. `undici`'s `ProxyAgent` only does this
 * for plain HTTP on both ends, but the tests need forward mode over an HTTPS proxy too.
 */
const forwardToProxy = (proxyAuthorization?: string): Dispatcher.DispatcherComposeInterceptor => {
    const proxyHeaders = proxyAuthorization ? { 'proxy-authorization': proxyAuthorization } : {};

    return (dispatch) => (opts, handler) => {
        const { origin, path = '/', headers = {} } = opts;

        return dispatch({
            ...opts,
            path: `${String(origin)}${path}`,
            headers: { host: new URL(String(origin)).host, ...proxyHeaders, ...headers },
        }, handler);
    };
};

/**
 * `undici` pools sockets, but the proxy tests count connections, so every call gets its
 * own dispatcher by default.
 *
 * Like Node's own clients, a plain HTTP target is forwarded with an absolute request URI
 * and anything else gets a CONNECT tunnel. Both paths exist in the proxy under test.
 */
export const createDispatcher = (opts: ConnectionOpts): Dispatcher => {
    const tls = opts.ignoreCertificateErrors ? { rejectUnauthorized: false } : {};
    const connectTimeout = opts.timeoutMillis;

    if (!opts.proxyUrl) return new Agent({ connectTimeout, connect: tls });

    const proxy = new URL(opts.proxyUrl);
    // `undici` only derives this when both parts are set, but the suite covers username-only proxies.
    const token = proxy.username || proxy.password
        ? toBasicAuth(proxy.username, proxy.password)
        : undefined;

    if (new URL(opts.url).protocol === 'http:') {
        return new Client(proxy.origin, { connect: tls, connectTimeout }).compose(forwardToProxy(token));
    }

    // `undici`'s WebSocket support rewrites ws(s): to http(s): before dispatching, so a `ws:`
    // target looks like plain HTTP to `ProxyAgent` here. Since undici 8, `ProxyAgent` only
    // tunnels plain-HTTP requests through CONNECT when `proxyTunnel` is set - otherwise it
    // forwards them (no CONNECT), which breaks the Upgrade handshake through this proxy.
    const proxyTunnel = true;
    // undici passes the proxy's literal hostname as the TLS `servername` for the proxy
    // connection; Node's TLS layer rejects an IP address there. Certificate validation is
    // already disabled above when needed, so any non-IP placeholder is fine.
    const proxyTls = net.isIP(proxy.hostname) ? { ...tls, servername: 'localhost-test' } : tls;

    return new ProxyAgent({ uri: proxy.origin, token, connectTimeout, requestTls: tls, proxyTls, proxyTunnel });
};

/** Splits credentials out of the URL into a Basic header. */
const extractBasicAuth = (url: string): { url: string; authorization?: string } => {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return { url };

    const authorization = toBasicAuth(parsed.username, parsed.password);
    parsed.username = '';
    parsed.password = '';

    return { url: parsed.href, authorization };
};

const joinRepeatingHeaders = (headers: Record<string, string | string[] | undefined>): Record<string, string> => {
    return Object.fromEntries(
        Object.entries(headers)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value as string]),
    );
};

export const httpRequest = async (opts: HttpRequestOpts): Promise<HttpResponse> => {
    const { url, authorization } = extractBasicAuth(opts.url);

    const dispatcher = opts.dispatcher ?? createDispatcher(opts);
    const isDispatcherOwned = !opts.dispatcher;

    try {
        const response = await request(url, {
            dispatcher: dispatcher.compose(REDIRECT_INTERCEPTOR),
            method: opts.method ?? 'GET',
            headers: {
                ...opts.headers,
                ...authorization ? { authorization } : {},
            },
            body: opts.body,
            headersTimeout: opts.timeoutMillis,
            bodyTimeout: opts.timeoutMillis,
        });

        const headers = joinRepeatingHeaders(response.headers);
        // `undici.request` hands back the raw body, unlike `fetch`.
        const body = headers['content-encoding'] === 'gzip'
            ? (await gunzip(Buffer.from(await response.body.arrayBuffer()))).toString()
            : await response.body.text();

        if (isDispatcherOwned) await dispatcher.close();

        return { statusCode: response.statusCode, headers, body };
    } catch (error) {
        // Unlike `close()`, this does not wait for the request that just failed.
        if (isDispatcherOwned) await dispatcher.destroy();
        throw error;
    }
};
