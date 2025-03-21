import http from 'node:http';
import stream from 'node:stream';
import type { URL } from 'node:url';
import util from 'node:util';

import { SocksProxyAgent } from 'socks-proxy-agent';

import { badGatewayStatusCodes, errorCodeToStatusCode } from './statuses';
import { countTargetBytes } from './utils/count_target_bytes';
import { validHeadersOnly } from './utils/valid_headers_only';

const pipeline = util.promisify(stream.pipeline);

interface Options {
    method: string;
    headers: string[];
    insecureHTTPParser: boolean;
    path?: string;
    localAddress?: string;
    agent: http.Agent;
}

export interface HandlerOpts {
    upstreamProxyUrlParsed: URL;
    localAddress?: string;
}

/**
 * ```
 * Client -> Apify (HTTP) -> Upstream (SOCKS) -> Web
 * Client <- Apify (HTTP) <- Upstream (SOCKS) <- Web
 * ```
 */
export const forwardSocks = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    handlerOpts: HandlerOpts,
    // eslint-disable-next-line no-async-promise-executor
): Promise<void> => new Promise(async (resolve, reject) => {
    const agent = new SocksProxyAgent(handlerOpts.upstreamProxyUrlParsed);

    const options: Options = {
        method: request.method!,
        headers: validHeadersOnly(request.rawHeaders),
        insecureHTTPParser: true,
        localAddress: handlerOpts.localAddress,
        agent,
    };

    // Only handling "http" here - since everything else is handeled by tunnelSocks.
    // We have to force cast `options` because @types/node doesn't support an array.
    const client = http.request(request.url!, options as unknown as http.ClientRequestArgs, async (clientResponse) => {
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
    });

    client.once('socket', (socket) => {
        countTargetBytes(request.socket, socket);
    });

    // Can't use pipeline here as it automatically destroys the streams
    request.pipe(client);
    client.on('error', (error: NodeJS.ErrnoException) => {
        if (response.headersSent) {
            return;
        }

        const statusCode = errorCodeToStatusCode[error.code!] ?? badGatewayStatusCodes.GENERIC_ERROR;

        response.statusCode = statusCode;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end(http.STATUS_CODES[response.statusCode]);

        resolve();
    });
});
