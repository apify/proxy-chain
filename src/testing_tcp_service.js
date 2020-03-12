const net = require('net');

// TODO: please move this into ./test dir

const server = net.createServer();

server.on('connection', handleConnection);

server.listen(9112, () => {
    console.log('server listening to %j', server.address());
});

function handleConnection(conn) {
    const remoteAddress = `${conn.remoteAddress}:${conn.remotePort}`;
    console.log('new client connection from %s', remoteAddress);

    conn.setEncoding('utf8');

    conn.on('data', onConnData);
    conn.on('close', onConnClose);
    conn.on('error', onConnError);

    function onConnData(d) {
        console.log('connection data from %s: %j', remoteAddress, d);
        conn.write(d);
    }

    function onConnClose() {
        console.log('connection from %s closed', remoteAddress);
    }

    function onConnError(err) {
        console.log('Connection %s error: %s', remoteAddress, err.message);
    }
}
