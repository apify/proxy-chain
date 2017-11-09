import http from 'http';
import net from 'net';
import _ from 'underscore';
import { parseUrl, tee } from './tools';


/**
 * Represents a proxied connection from source to another external proxy using HTTP CONNECT.
 */
export default class HandlerTunnelChain {

    constructor({ srcRequest, srcSocket, trgProxyUrl, trgHost, trgPort, verbose }) {
        this.srcRequest = srcRequest;
        this.srcSocket = srcSocket;
        this.verbose = verbose;

        // Indicates that source connection might have received some data already
        this.srcGotResponse = false;

        this.trgProxyUrl = trgProxyUrl;
        this.trgProxyUrlParsed = parseUrl(trgProxyUrl);
        this.trgHost = trgHost;
        this.trgPort = trgPort;
        this.trgSocket = null;

        if (!this.trgProxyUrlParsed.host || !this.trgProxyUrlParsed.port) throw new Error('trgProxyUrl is invalid');
        if (this.trgProxyUrlParsed.scheme !== 'http') throw new Error('trgProxyUrl must have "http" protocol');

        // Bind all event handlers to 'this'
        ['onSrcClose', 'onSrcEnd', 'onSrcError', 'onTrgConnect', 'onTrgClose', 'onTrgEnd',
         'onTrgError', 'onSrcResponseFinish', 'onTrgAbort'].forEach((evt) => {
            this[evt] = this[evt].bind(this);
        });

        this.srcSocket.on('close', this.onSrcClose);
        this.srcSocket.on('end', this.onSrcEnd);
        this.srcSocket.on('error', this.onSrcError);

        // Create ServerResponse for the client request, since Node.js doesn't create one
        // NOTE: This is undocumented API, it might break in the future
        this.srcResponse = new http.ServerResponse(srcRequest);
        this.srcResponse.shouldKeepAlive = false;
        this.srcResponse.chunkedEncoding = false;
        this.srcResponse.useChunkedEncodingByDefault = false;
        this.srcResponse.assignSocket(srcSocket);

        // called for the ServerResponse's "finish" event
        // XXX: normally, node's "http" module has a "finish" event listener that would
        // take care of closing the socket once the HTTP response has completed, but
        // since we're making this ServerResponse instance manually, that event handler
        // never gets hooked up, so we must manually close the socket...
        this.srcResponse.once('finish', this.onSrcResponseFinish);

        // TODO: pause the socket during authentication so no data is lost
        this.srcSocket.pause();
    }

    log(str) {
        if (this.verbose) console.log(`HandlerTunnelChain[${this.trgProxyUrl} -> ${this.trgHost}:${this.trgPort}]: ${str}`);
    }

    run() {
        this.log('Connecting to target proxy...');

        let options = {
            method: 'CONNECT',
            host: this.trgProxyUrlParsed.hostname,
            port: this.trgProxyUrlParsed.port,
            path: `${this.trgHost}:${this.trgPort}`,
            headers: {},
        };

        if (this.trgProxyUrlParsed.username) {
            let auth = this.trgProxyUrlParsed.username;
            if (this.trgProxyUrlParsed.password) auth += ':' + this.trgProxyUrlParsed.password;
            options.headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
        }

        console.dir(options);
        this.trgRequest = http.request(options);

        this.trgRequest.on('connect', this.onTrgConnect);
        this.trgRequest.on('abort', this.onTrgAbort);
        this.trgRequest.on('error', this.onTrgError);

        this.trgRequest.on('continue', () => {
            this.log('Target continue');
        });

        this.trgRequest.on('socket', () => {
            this.log('Target socket');
        });

        this.trgRequest.on('timeout', () => {
            this.log('Target timeout');
        });

        // Send the data
        this.trgRequest.end();



/*
        this.trgSocket = net.createConnection(this.trgProxyUrlParsed.port, this.trgProxyUrlParsed.hostname);


        this.trgSocket.on('connect', this.onTrgConnect);

        this.trgSocket.on('close', this.onTrgClose);
        this.trgSocket.on('end', this.onTrgEnd);
        this.trgSocket.on('error', this.onTrgError); */
    }

    onSrcResponseFinish() {
        this.log('Source response finished');
        this.srcResponse.detachSocket(socket);
        this.srcSocket.end();
    }

    onSrcClose() {
        this.log(`Source socket closed`);
    }

    onSrcEnd() {
        this.log(`Source socket ended`);
        this.removeListeners();
    }

    onSrcError(err) {
        this.log(`Source socket failed: ${err.stack || err}`);
    }

    generateHttpConnect() {
        let str = `CONNECT ${this.trgProxyUrlParsed.hostname}:${this.trgProxyUrlParsed.port} HTTP/1.1\r\n`
            + `Host: ${this.trgHost}:${this.trgPort}\r\n`;

        if (this.trgProxyUrlParsed.username) {
            let auth = this.trgProxyUrlParsed.username;
            if (this.trgProxyUrlParsed.password) auth += ':' + this.trgProxyUrlParsed.password;
            str += `Proxy-Authorization: basic ${Buffer.from(auth).toString('base64')}\r\n`;
        }
        str += '\r\n';

        console.log(str);

        return str;
    }

    onTrgConnect (response, socket, head) {
        this.log(`Connected to target proxy`);

        this.srcGotResponse = true;
        this.srcResponse.removeListener('finish', this.onSrcResponseFinish);
        this.srcResponse.writeHead(200, 'Connection established');

        //this.response.writeHead(response.statusCode, response.statusMessage);

        this.trgSocket = socket;

        // HACK: force a flush of the HTTP header
        this.srcResponse._send('');

        // relinquish control of the `socket` from the ServerResponse instance
        this.srcResponse.detachSocket(this.srcSocket);

        // nullify the ServerResponse object, so that it can be cleaned
        // up before this socket proxying is completed
        this.srcResponse = null;

        this.srcSocket.resume();

        // TODO: attach handlers to trgSocket


        // Setup bi-directional tunnel
        this.trgSocket.pipe(tee('to src')).pipe(this.srcSocket);
        this.srcSocket.pipe(tee('to trg')).pipe(this.trgSocket);


        console.log('got connected!');




/*
        this.trgSocket.write(this.generateHttpConnect(), (err) => {

            if (err) {
                this.onTrgError(err);
                return;
            }

            console.log('piping...');

            // create tunnel


            // Setup bi-directional tunnel
            this.trgSocket.pipe(tee('to src')).pipe(this.srcSocket);
            this.srcSocket.pipe(tee('to trg')).pipe(this.trgSocket);
        }); */
    }

    /**
     * Target closed the connection.
     * @private
     */
    onTrgClose() {
        this.log('Target connection closed');
        this.removeListeners();
        this.srcSocket.destroy();
    }

    onTrgAbort() {
        this.log('Target aborted');
        this.removeListeners();
        this.srcSocket.destroy();
    }

    onTrgEnd() {
        this.log('Target connection ended');
        this.removeListeners();
    }

    onTrgError(err) {
        this.log(`Target connection failed: ${err.stack || err}`);

        this.removeListeners();

        if (this.srcGotResponse) {
            this.log('already sent a response, just destroying the socket...');
            this.srcSocket.destroy();
        } else if (err.code === 'ENOTFOUND') {
            this.log('Target not found, sending 404 to source');
            this.srcResponse.writeHead(404);
            this.srcResponse.end();
        } else {
            this.log('Unknown error, sending 500 to source');
            this.srcResponse.writeHead(500);
            this.srcResponse.end();
        }
    }

    /**
     * Detaches all listeners from all both source and target sockets.
     */
    removeListeners () {
        this.log('Detaching listeners');

        this.srcSocket.removeListener('close', this.onSrcClose);
        this.srcSocket.removeListener('error', this.onSrcError);
        this.srcSocket.removeListener('end', this.onSrcEnd);

        if (this.trgSocket) {
            this.trgSocket.removeListener('connect', this.onTrgConnect);
            this.trgSocket.removeListener('close', this.onTrgClose);
            this.trgSocket.removeListener('end', this.onTrgEnd);
            this.trgSocket.removeListener('error', this.onTrgError);
        }

        if (this.trgRequest) {
            this.trgRequest.removeAllListeners();
        }
    }

}