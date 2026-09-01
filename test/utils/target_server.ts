import type { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';

import { parse as parseBasicAuth } from 'basic-auth';
import bodyParser from 'body-parser';
import express from 'express';
import _ from 'underscore';
import { type WebSocket, WebSocketServer } from 'ws';

import { closeServer, listenOnPort } from './test_helpers.js';

type TargetServerOptions = {
    port: number;
    useSsl?: boolean;
    sslKey?: Buffer;
    sslCrt?: Buffer;
};

/**
 * A HTTP server used for testing. It supports HTTPS and web sockets.
 */
class TargetServer {
    port: number;

    useSsl?: boolean;

    app: express.Express;

    httpServer: http.Server;

    wsUpgServer: WebSocketServer;

    constructor({
        port, useSsl, sslKey, sslCrt,
    }: TargetServerOptions) {
        this.port = port;
        this.useSsl = useSsl;

        this.app = express();

        // Parse an HTML body into a string
        this.app.use(bodyParser.text({ type: 'text/*', limit: '10MB' }));

        this.app.all('/hello-world', this.allHelloWorld.bind(this));
        this.app.all('/echo-request-info', this.allEchoRequestInfo.bind(this));
        this.app.all('/echo-raw-headers', this.allEchoRawHeaders.bind(this));
        this.app.all('/echo-payload', this.allEchoPayload.bind(this));
        this.app.get('/redirect-to-hello-world', this.getRedirectToHelloWorld.bind(this));
        this.app.get('/get-1m-a-chars-together', this.get1MACharsTogether.bind(this));
        this.app.get('/get-1m-a-chars-streamed', this.get1MACharsStreamed.bind(this));
        this.app.get('/basic-auth', this.getBasicAuth.bind(this));
        this.app.get('/get-non-standard-headers', this.getNonStandardHeaders.bind(this));
        this.app.get('/get-invalid-status-code', this.getInvalidStatusCode.bind(this));
        this.app.get('/get-repeating-headers', this.getRepeatingHeaders.bind(this));

        this.app.all('*', this.handleHttpRequest.bind(this));

        if (useSsl) {
            this.httpServer = https.createServer({ key: sslKey, cert: sslCrt }, this.app);
        } else {
            this.httpServer = http.createServer(this.app);
        }

        // Node.js 20+ enables HTTP keep-alive by default, which causes connection
        // tracking issues in tests. Disable keep-alive on the target server.
        this.httpServer.keepAliveTimeout = 0;

        // Web socket server for upgraded HTTP connections
        this.wsUpgServer = new WebSocketServer({ server: this.httpServer });
        this.wsUpgServer.on('connection', this.onWsConnection.bind(this));
    }

    async listen(): Promise<void> {
        await listenOnPort(this.httpServer, this.port);
    }

    allHelloWorld(_request: express.Request, response: express.Response): void {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('Hello world!');
    }

    allEchoRequestInfo(request: express.Request, response: express.Response): void {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        const result = _.pick(request, 'headers', 'method');
        response.end(JSON.stringify(result));
    }

    allEchoRawHeaders(request: express.Request, response: express.Response): void {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(request.rawHeaders));
    }

    allEchoPayload(request: express.Request, response: express.Response): void {
        response.writeHead(200, { 'Content-Type': request.headers['content-type'] || 'dummy' });
        // console.log('allEchoPayload: ' + request.body.length);
        response.end(request.body);
    }

    get1MACharsTogether(_request: express.Request, response: express.Response): void {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end(''.padStart(1000 * 1000, 'a'));
    }

    get1MACharsStreamed(_request: express.Request, response: express.Response): void {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        for (let i = 0; i < 10000; i++) {
            response.write(`${''.padStart(99, 'a')}\n`);
        }
        response.end();
    }

    getRedirectToHelloWorld(_request: express.Request, response: express.Response): void {
        const location = `${this.useSsl ? 'https' : 'http'}://localhost:${this.port}/hello-world`;
        response.writeHead(301, { 'Content-Type': 'text/plain', Location: location });
        response.end();
    }

    getBasicAuth(request: express.Request, response: express.Response): void {
        const authHeader = request.headers.authorization;
        const auth = authHeader ? parseBasicAuth(authHeader) : undefined;
        // Using special char $ to test URI-encoding feature!
        // Beware that this is web server auth, not the proxy auth, so this doesn't really test our proxy server
        // But it should work anyway
        if (!auth || auth.name !== 'john.doe$' || auth.pass !== 'Passwd$') {
            response.statusCode = 401;
            response.setHeader('WWW-Authenticate', 'Basic realm="MyRealmName"');
            response.end('Unauthorized');
        } else {
            response.end('OK');
        }
    }

    handleHttpRequest(_request: express.Request, response: express.Response): void {
        console.log('Received request');

        // const message = request.body;
        // const remoteAddr = request.socket.remoteAddress;

        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('It works!');
    }

    getNonStandardHeaders(request: express.Request, _response: express.Response): void {
        const headers: Record<string, string> = {
            'Invalid Header With Space': 'HeaderValue1',
            'X-Normal-Header': 'HeaderValue2',
        };

        // This is a regression test for "TypeError: The header content contains invalid characters"
        // that occurred in production
        if (request.query.skipInvalidHeaderValue !== '1') {
            headers['Invalid-Header-Value'] = 'some\value';
        }

        let msg = `HTTP/1.1 200 OK\r\n`;
        _.each(headers, (value, key) => {
            msg += `${key}: ${value}\r\n`;
        });
        msg += `\r\nHello sir!`;

        request.socket.write(msg, () => {
            request.socket.end();

            // Unfortunately calling end() will not close the socket
            // if client refuses to close it. Hence calling destroy after a short while.
            setTimeout(() => {
                request.socket.destroy();
            }, 100);
        });
    }

    getInvalidStatusCode(request: express.Request, _response: express.Response): void {
        let msg = `HTTP/1.1 55 OK\r\n`;
        msg += `\r\nBad status!`;

        request.socket.write(msg, () => {
            request.socket.end();

            // Unfortunately calling end() will not close the socket
            // if client refuses to close it. Hence calling destroy after a short while.
            setTimeout(() => {
                request.socket.destroy();
            }, 100);
        });
    }

    getRepeatingHeaders(_request: express.Request, response: express.Response): void {
        response.writeHead(200, {
            'Content-Type': 'text/plain',
            'Repeating-Header': ['HeaderValue1', 'HeaderValue2'],
        });
        response.end('Hooray!');
    }

    onWsConnection(ws: WebSocket): void {
        ws.on('error', (err) => {
            console.log(`Web socket error: ${err.stack || err}`);
            throw err;
        });

        ws.on('close', () => {
            // console.log(`Web socket closed`);
        });

        // Simply send data back
        ws.on('message', (data) => {
            ws.send(`I received: ${data}`);
        });
    }

    async close(): Promise<void> {
        return await closeServer(this.httpServer);
    }
}

export { TargetServer };
