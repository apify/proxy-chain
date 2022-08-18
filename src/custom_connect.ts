import net from 'net';
import type http from 'http';
import { promisify } from 'util';
// import { countTargetBytes } from './utils/count_target_bytes';

const asyncWrite = promisify(net.Socket.prototype.write);

export const customConnect = async (socket: net.Socket, server: http.Server): Promise<void> => {
    // countTargetBytes(socket, socket);

    await asyncWrite.call(socket, 'HTTP/1.1 200 Connection Established\r\n\r\n');
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
