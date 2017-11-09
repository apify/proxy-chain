import http from 'http';
import { parseHostHeader } from './tools';
import Promise from 'bluebird';
import HandlerTunnelDirect from './handler_tunnel_direct';
import HandlerProxyDirect from './handler_proxy_direct';
import HandlerTunnelChain from './handler_tunnel_chain';


export default class ProxyServer {
    /**
     * Initializes a new instance of ProxyServer class.
     * @param options
     * @param [options.port]
     * @param [options.targetProxyUrl] Optional URL to target proxy. If not specified, the server works as a simple proxy.
     * @param [options.targetProxyUrlGenerator] TODO: A function that accepts parameters (host, port) that returns a promise resolving to a URL of target proxy to use.
     * @param [options.verbose]
     */
    constructor(options) {
        // HTTP server instance
        this.server = http.createServer();

        options = options || {};
        this.port = options.port || 8000;
        this.verbose = !!options.verbose;
        this.targetProxyUrl = options.targetProxyUrl;

        this.server.on('clientError', this.onClientError.bind(this));
        this.server.on('request', this.onRequest.bind(this));
        this.server.on('connect', this.onConnect.bind(this));
    }

    log(str) {
        if (this.verbose) console.log(`ProxyServer[${this.port}]: ${str}`)
    }

    onClientError(err, socket) {
        this.log(`onClientError: ${err}`);
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }

    onConnect(request, socket, head) {
        this.log(`${request.method} ${request.url} HTTP/${request.httpVersion}`);
        //console.dir(request.headers);

        const { host, port } = parseHostHeader(request.headers['host']);
        if (!host || !port) {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\nInvalid Host header!');
        }

        if (!this.targetProxyUrl) {
            const handler = new HandlerTunnelDirect({
                srcRequest: request,
                srcSocket: socket,
                trgHost: host,
                trgPort: port,
                verbose: this.verbose,
            });
            handler.run();
        } else {
            const handler = new HandlerTunnelChain({
                srcRequest: request,
                srcSocket: socket,
                trgProxyUrl: this.targetProxyUrl,
                trgHost: host,
                trgPort: port,
                verbose: this.verbose,
            });
            handler.run();
        }
    }

    onRequest(request, response) {
        this.log(`${request.method} ${request.url} HTTP/${request.httpVersion}`);

        if (!this.targetProxyUrl) {
            const handler = new HandlerProxyDirect({
                srcRequest: request,
                srcResponse: response,
                verbose: this.verbose,
            });
            handler.run();
            return;
        }
    }

    /**
     *
     * @param callback Optional callback
     * @return {*}
     */
    listen(callback) {
        return Promise.promisify(this.server.listen.bind(this.server))(this.port)
            .then(() => {
                this.log('Listening...');
            })
            .catch((err) => {
                this.log(`Listen failed: ${err}`);
                throw err;
            })
            .nodeify(callback);
    }

    close(closeConnections, callback) {
        // TODO: keep track of all handlers and add close them if closeConnections=true
        if (this.server) {
            const server = this.server;
            this.server = null;
            return Promise.promisify(this.server.close)().nodeify(callback);
        }
    }
}