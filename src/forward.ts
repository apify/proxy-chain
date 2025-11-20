import type dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import stream from 'node:stream';
import type { URL } from 'node:url';
import util from 'node:util';

import { badGatewayStatusCodes, errorCodeToStatusCode } from './statuses';
import type { SocketWithPreviousStats } from './utils/count_target_bytes';
import { countTargetBytes } from './utils/count_target_bytes';
import { getBasicAuthorizationHeader } from './utils/get_basic';
import { validHeadersOnly } from './utils/valid_headers_only';

const pipeline = util.promisify(stream.pipeline);

interface Options {
    method: string;
    headers: string[];
    insecureHTTPParser: boolean;
    path?: string;
    localAddress?: string;
    family?: number;
    lookup?: typeof dns['lookup'];
}

export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    ignoreUpstreamProxyCertificate: boolean;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
    httpAgent?: http.Agent;
    httpsAgent?: https.Agent;
}

/**
 * The request is read from the client and is resent.
 * This is similar to Direct / Chain, however it uses the CONNECT protocol instead.
 * Forward uses standard HTTP methods.
 *
 * ```
 * Client -> Apify (HTTP) -> Web
 * Client <- Apify (HTTP) <- Web
 * ```
 *
 * or
 *
 * ```
 * Client -> Apify (HTTP) -> Upstream (HTTP) -> Web
 * Client <- Apify (HTTP) <- Upstream (HTTP) <- Web
 * ```
 */
export const forward = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    handlerOpts: HandlerOpts,
    // eslint-disable-next-line no-async-promise-executor
): Promise<void> => new Promise(async (resolve, reject) => {
    const proxy = handlerOpts.upstreamProxyUrlParsed;
    const origin = proxy ? proxy.origin : request.url;

    const options: Options = {
        method: request.method!,
        headers: validHeadersOnly(request.rawHeaders),
        insecureHTTPParser: true,
        localAddress: handlerOpts.localAddress,
        family: handlerOpts.ipFamily,
        lookup: handlerOpts.dnsLookup,
    };

    // In case of proxy the path needs to be an absolute URL
    if (proxy) {
        options.path = request.url;

        try {
            if (proxy.username || proxy.password) {
                options.headers.push('proxy-authorization', getBasicAuthorizationHeader(proxy));
            }
        } catch (error) {
            reject(error);
            return;
        }
    }

    const requestCallback = async (clientResponse: http.IncomingMessage) => {
        try {
            // This is necessary to prevent Node.js throwing an error
            let statusCode = clientResponse.statusCode!;
            if (statusCode < 100 || statusCode > 999) {
                statusCode = badGatewayStatusCodes.STATUS_CODE_OUT_OF_RANGE;
            }

            // 407 is handled separately
            if (clientResponse.statusCode === 407) {
                reject(new Error('407 Proxy Authentication Required'));
                return;
            }

            response.writeHead(
                statusCode,
                clientResponse.statusMessage,
                validHeadersOnly(clientResponse.rawHeaders),
            );

            // `pipeline` automatically handles all the events and data
            await pipeline(
                clientResponse,
                response,
            );

            resolve();
        } catch {
            // Client error, pipeline already destroys the streams, ignore.
            resolve();
        }
    };

    // We have to force cast `options` because @types/node doesn't support an array.
    const client = origin!.startsWith('https:')
        ? https.request(origin!, {
            ...options as unknown as https.RequestOptions,
            rejectUnauthorized: handlerOpts.upstreamProxyUrlParsed ? !handlerOpts.ignoreUpstreamProxyCertificate : undefined,
            agent: handlerOpts.httpsAgent,
        }, requestCallback)

        : http.request(origin!, {
            ...options as unknown as http.RequestOptions,
            agent: handlerOpts.httpAgent,
        }, requestCallback);

    client.once('socket', (socket: SocketWithPreviousStats) => {
        // Socket can be re-used by multiple requests.
        // That's why we need to track the previous stats.
        socket.previousBytesRead = socket.bytesRead;
        socket.previousBytesWritten = socket.bytesWritten;
        countTargetBytes(request.socket, socket, (handler) => response.once('close', handler));
    });

    // Can't use pipeline here as it automatically destroys the streams
    request.pipe(client);
    client.on('error', (error: NodeJS.ErrnoException) => {
        if (response.headersSent) {
            return;
        }

        const statusCode = errorCodeToStatusCode[error.code!] ?? badGatewayStatusCodes.GENERIC_ERROR;

        response.statusCode = !proxy && error.code === 'ENOTFOUND' ? 404 : statusCode;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end(http.STATUS_CODES[response.statusCode]);

        resolve();
    });
});
