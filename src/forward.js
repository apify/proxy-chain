const http = require('http');
const https = require('https');
const stream = require('stream');
const util = require('util');
const { isHopByHopHeader } = require('./tools');

const pipeline = util.promisify(stream.pipeline);

const validHeadersOnly = (array) => {
    const rawHeaders = [];

    let containsHost = false;

    for (let i = 0; i < array.length; i += 2) {
        const name = array[i];
        const value = array[i + 1];

        try {
            http.validateHeaderName(name);
            http.validateHeaderValue(name, value);
        } catch (error) {
            continue;
        }

        if (isHopByHopHeader(name)) {
            continue;
        }

        if (name.toLowerCase() === 'host') {
            if (containsHost) {
                continue;
            }

            containsHost = true;
        }

        rawHeaders.push(name, value);
    }

    return rawHeaders;
};

// eslint-disable-next-line no-async-promise-executor
const forward = async (request, response, handlerOpts) => new Promise(async (resolve, reject) => {
    const proxy = handlerOpts.upstreamProxyUrlParsed;
    const origin = proxy ? proxy.origin : request.url;

    const options = {
        method: request.method,
        headers: validHeadersOnly(request.rawHeaders),
    };

    if (proxy) {
        options.path = request.url;

        try {
            if (proxy.username || proxy.password) {
                const auth = `${proxy.username}:${proxy.password}`;

                options.headers.push('proxy-authorization', `Basic ${Buffer.from(auth).toString('base64')}`);
            }
        } catch (error) {
            reject(error);
            return;
        }
    }

    const fn = origin.startsWith('https:') ? https.request : http.request;

    const client = fn(origin, options, async (clientResponse) => {
        try {
            let { statusCode } = clientResponse;
            if (statusCode < 100 || statusCode > 999) {
                statusCode = 502;
            }

            if (clientResponse.statusCode === 407) {
                reject(new Error('407 Proxy Authentication Required'));
                return;
            }

            response.writeHead(
                statusCode,
                clientResponse.statusMessage,
                validHeadersOnly(clientResponse.rawHeaders),
            );

            await pipeline(
                clientResponse,
                response,
            );

            resolve();
        } catch (error) {
            reject(error);
        }
    });

    try {
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
