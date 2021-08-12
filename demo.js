// npm run build && node --trace-warnings demo.js

const ProxyChain = require('.');
const net = require('net');

const server = new ProxyChain.Server({
    port: 8080,
});

server.server.prependOnceListener('connection', (_socket) => {
    socket = _socket;
    setInterval(() => {
        console.log(_socket.listenerCount('error'));
    }, 1000);
});

server.listen(() => {
    const client = net.connect({
        host: 'localhost',
        port: 8080,
    });

    for (let i = 0; i < 20; i++) {
        client.write('GET http://httpbin.org/anything HTTP/1.1\r\nconnection: keep-alive\r\nhost: httpbin.org\r\n\r\n');
    }

    client.resume();
    client.on('error', console.log);

    // client.pipe(process.stdout);
});
