import http from 'http';
import https from 'https';
import express from 'express';
import WebSocket from 'ws';
import Promise from 'bluebird';


/**
 * A HTTP server used for testing. It supports HTTPS and web sockets.
 */
export class TargetServer {
    constructor({ port, useSsl, sslKey, sslCrt }) {
        this.port = port;

        this.app = express();

        this.app.get('/hello-world', this.getHelloWorld.bind(this));
        this.app.all('*', this.handleHttpRequest.bind(this));

        if (useSsl) {
            this.httpServer = https.createServer({ key: sslKey, cert: sslCrt }, this.app);
        } else {
            this.httpServer = http.createServer(this.app);
        }

        // web socket server for connections from web servers (to subscribe for live execution status)
        this.wsServer = new WebSocket.Server({ server: this.httpServer });
        this.wsServer.on('connection', this.onWsConnection.bind(this));
    }

    listen() {
        return Promise.promisify(this.httpServer.listen).bind(this.httpServer)(this.port);
    }

    getHelloWorld(request, response) {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('Hello world!');
    }

    handleHttpRequest(request, response) {
        console.log('Received request');

        //const message = request.body;
        //const remoteAddr = request.socket.remoteAddress;

        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('It works!');
    }

    onWsConnection(ws, req) {
        //const clientIp = JSON.stringify(ws.upgradeReq.socket.remoteAddress);

        ws.on('error', (err) => {
            console.log(`Web socket error: ${err.stack || err}`);
        });

        ws.on('close', (code) => {
            console.log(`Web socket closed`);
        });

        ws.on('message', (message) => {
            console.log('Received WS message');
            //ws.send();
        });
    }

    close() {
        return Promise.promisify(this.httpServer.close).bind(this.httpServer)();
    }
}
