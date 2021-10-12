<<<<<<< HEAD
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
=======
import http from 'http';
import https from 'https';
import stream from 'stream';
import util from 'util';
import { URL } from 'url';
import { validHeadersOnly } from './utils/valid_headers_only';
import { getBasicAuthorizationHeader } from './utils/get_basic';
import { countTargetBytes } from './utils/count_target_bytes';
>>>>>>> f1bbe42 (release: 2.0.0 (#162))

const pipeline = util.promisify(stream.pipeline);

interface Options {
    method: string;
    headers: string[];
    insecureHTTPParser: boolean;
    path?: string;
    localAddress?: string;
<<<<<<< HEAD
    family?: number;
    lookup?: typeof dns['lookup'];
=======
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
}

export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
<<<<<<< HEAD
    ignoreUpstreamProxyCertificate: boolean;
    localAddress?: string;
    ipFamily?: number;
    dnsLookup?: typeof dns['lookup'];
=======
    localAddress?: string;
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
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
<<<<<<< HEAD
        family: handlerOpts.ipFamily,
        lookup: handlerOpts.dnsLookup,
=======
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
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

<<<<<<< HEAD
    const requestCallback = async (clientResponse: http.IncomingMessage) => {
=======
    const fn = origin!.startsWith('https:') ? https.request : http.request;

    // We have to force cast `options` because @types/node doesn't support an array.
    const client = fn(origin!, options as unknown as http.ClientRequestArgs, async (clientResponse) => {
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
        try {
            // This is necessary to prevent Node.js throwing an error
            let statusCode = clientResponse.statusCode!;
            if (statusCode < 100 || statusCode > 999) {
<<<<<<< HEAD
                statusCode = badGatewayStatusCodes.STATUS_CODE_OUT_OF_RANGE;
=======
                statusCode = 502;
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
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
<<<<<<< HEAD
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
        }, requestCallback)

        : http.request(origin!, options as unknown as http.RequestOptions, requestCallback);

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
=======
        } catch (error) {
            reject(error);
        }
    });

    client.once('socket', (socket) => {
        countTargetBytes(request.socket, socket);
    });

    try {
        // `pipeline` automatically handles all the events and data
        await pipeline(
            request,
            client,
        );
    } catch (error: any) {
        error.proxy = proxy;

        reject(error);
    }
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
});
