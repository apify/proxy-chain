import net from 'net';
import type http from 'http';
import { promisify } from 'util';

export const customConnect = async (socket: net.Socket, server: http.Server): Promise<void> => {
    // `countTargetBytes(socket, socket)` is incorrect here since `socket` is not a target.
    // We would have to create a new stream and pipe traffic through that,
    // however this would also increase CPU usage.
    // Also, counting bytes here is not correct since we don't know how the response is generated
    // (whether any additional sockets are used).

    const asyncWrite = promisify(socket.write).bind(socket);
    await asyncWrite('HTTP/1.1 200 Connection Established\r\n\r\n');
    server.emit('connection', socket);

    return new Promise((resolve) => {
        if (socket.destroyed) {
            resolve();
            return;
        }

        socket.once('close', () => {
            resolve();
        });
    });
};
