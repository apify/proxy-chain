const net = require('net');
const http = require('http');
const {got} = require('got-cjs');

net.createServer(socket => {
    socket.end('HTTP/1.1 200 OK\r\ninvalid header: test\r\n\r\n');
}).listen(8888, async () => {
    const stream = got.stream('http://localhost:8888');
    stream.on('data', console.log);
    stream.pipe(new http.ServerResponse({}));
    stream.on('error', () => {
        console.log('got error');
    });
    stream.on('end', () => {
        console.log('end!!');
    });
});
