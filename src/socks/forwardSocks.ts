import http from 'http';
import stream from 'stream';
import util from 'util';
import { URL } from 'url';
import type { SocksProxy } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { validHeadersOnly } from '../utils/valid_headers_only';
import { countTargetBytes } from '../utils/count_target_bytes';

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
    const { hostname, port, username, password } = handlerOpts.upstreamProxyUrlParsed;
    const proxy: SocksProxy = {
        host: hostname,
        port: Number(port),
        type: 4,
    };

    if (username || password) {
        proxy.type = 5;
        proxy.userId = username;
        proxy.password = password;
    }

    const options: Options = {
        method: request.method!,
        headers: validHeadersOnly(request.rawHeaders),
        insecureHTTPParser: true,
        localAddress: handlerOpts.localAddress,
        agent: new SocksProxyAgent(proxy),
    };

    // only handling http here - since https is handeled by tunnelSocks
    // We have to force cast `options` because @types/node doesn't support an array.
    const client = http.request(request.url!, options as unknown as http.ClientRequestArgs, async (clientResponse) => {
        try {
            // This is necessary to prevent Node.js throwing an error
            let statusCode = clientResponse.statusCode!;
            if (statusCode < 100 || statusCode > 999) {
                statusCode = 502;
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
});
