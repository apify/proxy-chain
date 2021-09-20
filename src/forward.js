const http = require('http');
const https = require('https');
const stream = require('stream');
const util = require('util');
const { validHeadersOnly } = require('./utils/valid_headers_only');
const { getBasic } = require('./utils/get_basic');
const { countTargetBytes } = require('./utils/count_target_bytes');

const pipeline = util.promisify(stream.pipeline);

/**
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 * @param {*} handlerOpts
 * @returns {Promise}
 */
// eslint-disable-next-line no-async-promise-executor
const forward = async (request, response, handlerOpts) => new Promise(async (resolve, reject) => {
    const proxy = handlerOpts.upstreamProxyUrlParsed;
    const origin = proxy ? proxy.origin : request.url;

    const options = {
        method: request.method,
        headers: validHeadersOnly(request.rawHeaders),
    };

    // In case of proxy the path needs to be an absolute URL
    if (proxy) {
        options.path = request.url;

        try {
            if (proxy.username || proxy.password) {
                options.headers.push('proxy-authorization', getBasic(proxy));
            }
        } catch (error) {
            reject(error);
            return;
        }
    }

    const fn = origin.startsWith('https:') ? https.request : http.request;

    const client = fn(origin, options, async (clientResponse) => {
        try {
            // This is necessary to prevent Node.js throwing an error
            let { statusCode } = clientResponse;
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
    } catch (error) {
        error.proxy = proxy;

        reject(error);
    }
});

module.exports = { forward };
