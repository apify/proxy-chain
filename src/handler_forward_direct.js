import http from 'http';
import url from 'url';
import _ from 'underscore';
import { isHopByHopHeader, tee } from './tools';


/**
 * Represents a proxied request to a HTTP server.
 */
export default class HandlerForwardDirect {

    constructor({ srcRequest, srcResponse, verbose }) {
        this.srcRequest = srcRequest;
        this.srcResponse = srcResponse;
        this.srcSocket = srcRequest.socket;
        this.verbose = verbose;

        // Indicates that source connection might have received some data already
        this.srcGotResponse = false;

        // Bind all event handlers to 'this'
        ['onSrcEnd', 'onSrcError', 'onSrcClose', 'onSrcResponseFinish', 'onTrgResponse', 'onTrgError'].forEach((evt) => {
            this[evt] = this[evt].bind(this);
        });

        this.srcSocket.on('close', this.onSrcClose);
        this.srcSocket.on('end', this.onSrcEnd);
        this.srcSocket.on('error', this.onSrcError);

        this.trgRequest = null;

        this.srcResponse.on('finish', this.onSrcResponseFinish);

        // XXX: pause the socket during authentication so no data is lost
        this.srcSocket.pause();
    }

    log(str) {
        if (this.verbose) console.log(`HandlerForwardDirect[${this.srcRequest.method} ${this.srcRequest.url}]: ${str}`);
    }

    run() {
        this.log('Connecting to target...');

        this.srcSocket.resume();

        const requestOptions = url.parse(this.srcRequest.url);
        requestOptions.method = this.srcRequest.method;
        requestOptions.headers = {};

        // setup outbound proxy request HTTP headers
        //TODO: var hasXForwardedFor = false;
        //var hasVia = false;
        //var via = '1.1 ' + hostname + ' (proxy/' + version + ')';

        for (let i = 0; i<this.srcRequest.rawHeaders.length; i += 2) {
            const headerName = this.srcRequest.rawHeaders[i];
            const headerValue = this.srcRequest.rawHeaders[i + 1];

            if (isHopByHopHeader(headerName)) continue;

            /*

            if (!hasXForwardedFor && 'x-forwarded-for' === keyLower) {
                // append to existing "X-Forwarded-For" header
                // http://en.wikipedia.org/wiki/X-Forwarded-For
                hasXForwardedFor = true;
                value += ', ' + socket.remoteAddress;
                debug.proxyRequest('appending to existing "%s" header: "%s"', key, value);
            }

            if (!hasVia && 'via' === keyLower) {
                // append to existing "Via" header
                hasVia = true;
                value += ', ' + via;
                debug.proxyRequest('appending to existing "%s" header: "%s"', key, value);
            }
            */

            requestOptions.headers[headerName] = headerValue;
        };

        /*
        // add "X-Forwarded-For" header if it's still not here by now
        // http://en.wikipedia.org/wiki/X-Forwarded-For
        if (!hasXForwardedFor) {
            headers['X-Forwarded-For'] = socket.remoteAddress;
            debug.proxyRequest('adding new "X-Forwarded-For" header: "%s"', headers['X-Forwarded-For']);
        }

        // add "Via" header if still not set by now
        if (!hasVia) {
            headers.Via = via;
            debug.proxyRequest('adding new "Via" header: "%s"', headers.Via);
        }

        // custom `http.Agent` support, set `server.agent`
        var agent = server.agent;
        if (null != agent) {
            debug.proxyRequest('setting custom `http.Agent` option for proxy request: %s', agent);
            parsed.agent = agent;
            agent = null;
        }
         */


        if (!requestOptions.port) requestOptions.port = 80;

        if (requestOptions.protocol !== 'http:') {
            // only "http://" is supported, "https://" should use CONNECT method
            this.srcResponse.writeHead(400);
            this.srcResponse.end('Only "http:" protocol prefix is supported\n');
            return;
        }

        this.log('Proxying HTTP request');

        this.trgRequest = http.request(requestOptions);
        this.trgRequest.on('response', this.onTrgResponse);
        this.trgRequest.on('error', this.onTrgError);

        this.srcRequest.pipe(tee('to trg')).pipe(this.trgRequest);
        //this.srcRequest.pipe(this.trgRequest);
    }

    onSrcEnd() {
        this.log(`Source socket ended`);
        this.removeListeners();
    }

    onSrcError(err) {
        this.log(`Source socket failed: ${err.stack || err}`);
    }

    // if the client closes the connection prematurely,
    // then close the upstream socket
    onSrcClose() {
        this.log('Source socket closed');
        this.trgRequest.abort();
        this.removeListeners();
    }

    onSrcResponseFinish () {
        this.log('Source response finished');
        this.removeListeners();
    }


    onTrgResponse(response) {
        this.log(`Received response from target (${response.statusCode})`);

        this.srcGotResponse = true;

        // Prepare response headers
        var headers = {};
        for (let i = 0; i<response.rawHeaders.length; i += 2) {
            const headerName = response.rawHeaders[i];
            const headerValue = response.rawHeaders[i + 1];

            if (isHopByHopHeader(headerName)) continue;

            headers[headerName] = headerValue;
        }

        this.srcResponse.writeHead(response.statusCode, headers);
        response.pipe(this.srcResponse);
    };


    onTrgError(err) {
        debug.proxyResponse('proxy HTTP request "error" event\n%s', err.stack || err);

        this.removeListeners();

        if (this.srcGotResponse) {
            this.log('already sent a response, just destroying the socket...');
            this.srcSocket.destroy();
        } else if (err.code === 'ENOTFOUND') {
            this.log('Target server not found, sending 404 to source');
            this.srcResponse.writeHead(404);
            this.srcResponse.end();
        } else {
            this.log('Unknown error, sending 500 to source');
            this.srcResponse.writeHead(500);
            this.srcResponse.end();
        }
    };


    removeListeners() {
        this.log('Removing listeners');
        this.srcSocket.removeListener('close', this.onSrcClose);
        this.srcSocket.removeListener('end', this.onSrcEnd);
        this.srcSocket.removeListener('error', this.onSrcError);
        this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
    }
}