"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.customConnect = void 0;
const node_util_1 = require("node:util");
const customConnect = async (socket, server) => {
    // `countTargetBytes(socket, socket)` is incorrect here since `socket` is not a target.
    // We would have to create a new stream and pipe traffic through that,
    // however this would also increase CPU usage.
    // Also, counting bytes here is not correct since we don't know how the response is generated
    // (whether any additional sockets are used).
    const asyncWrite = (0, node_util_1.promisify)(socket.write).bind(socket);
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
exports.customConnect = customConnect;
//# sourceMappingURL=custom_connect.js.map