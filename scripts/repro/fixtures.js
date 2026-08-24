/**
 * Shared fixtures for the GHSA-5vwf-g8jp-pgj3 reproduction: a credential-protected
 * upstream proxy and a target server that both live on loopback, so the only way to
 * reach the payload is through the tunnel.
 */

import http from 'node:http';
import net from 'node:net';

export const PROXY_USERNAME = 'owner';
export const PROXY_PASSWORD = 's3cr3t';
export const SECRET_PAYLOAD = 'PAYLOAD-ONLY-THE-PROXY-OWNER-SHOULD-REACH';

const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(`${PROXY_USERNAME}:${PROXY_PASSWORD}`).toString('base64')}`;

export const listen = (server, host, port = 0) => new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen({ port, host }, () => {
        server.off('error', reject);

        resolve(server.address().port);
    });
});

export const closeServer = (server) => new Promise((resolve) => { server.close(() => resolve()); });

export const readFirstChunk = (host, port, timeoutMillis = 5000) => new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });

    socket.setTimeout(timeoutMillis);
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(new Error('ETIMEDOUT')); });
    socket.once('data', (chunk) => { socket.destroy(); resolve(chunk.toString()); });
    socket.once('end', () => reject(new Error('closed without data')));
});

export const probe = async (host, port) => {
    try {
        return { reachable: true, payload: await readFirstChunk(host, port) };
    } catch (error) {
        return { reachable: false, reason: error.code ?? error.message };
    }
};

export const parseEndpoint = (endpoint) => {
    const { hostname, port } = new URL(`tcp://${endpoint}`);

    return { host: hostname.replace(/^\[|\]$/g, ''), port: Number(port) };
};

/** The upstream proxy the tunnel owner pays for. Only CONNECTs carrying their credentials get through. */
export const startUpstreamProxy = () => {
    const authorizedConnects = [];
    const proxy = http.createServer((_request, response) => { response.writeHead(405).end(); });

    proxy.on('connect', (request, clientSocket, head) => {
        if (request.headers['proxy-authorization'] !== EXPECTED_AUTHORIZATION) {
            clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            return;
        }

        authorizedConnects.push(request.url);

        const { host, port } = parseEndpoint(request.url);
        const targetSocket = net.connect({ host, port }, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

            if (head.length > 0) targetSocket.write(head);

            targetSocket.pipe(clientSocket).pipe(targetSocket);
        });

        targetSocket.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => targetSocket.destroy());
    });

    return { proxy, authorizedConnects };
};

export const startTarget = () => net.createServer((socket) => socket.end(SECRET_PAYLOAD));

/** Starts the proxy and the target on loopback and returns the arguments createTunnel() needs. */
export const startVictimServices = async () => {
    const target = startTarget();
    const targetPort = await listen(target, '127.0.0.1');

    const { proxy, authorizedConnects } = startUpstreamProxy();
    const proxyPort = await listen(proxy, '127.0.0.1');

    return {
        proxyUrl: `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@127.0.0.1:${proxyPort}`,
        targetHost: `127.0.0.1:${targetPort}`,
        authorizedConnects,
        close: async () => { await Promise.all([closeServer(proxy), closeServer(target)]); },
    };
};
