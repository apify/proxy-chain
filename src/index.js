
/* globals module */

import ProxyServer from './proxy_server';

const server = new ProxyServer({ port: 8000, verbose: true });

server.listen();


