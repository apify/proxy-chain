import { Server, RequestError } from './server';
import { parseUrl, redactUrl, redactParsedUrl } from './tools';
import { anonymizeProxy, closeAnonymizedProxy, listenConnectAnonymizedProxy } from './anonymize_proxy';
import { createTunnel, closeTunnel } from './tcp_tunnel';

/* globals module */

// Publicly exported functions and classes
const ProxyChain = {
    Server,
    RequestError,
    parseUrl,
    redactUrl,
    redactParsedUrl,
    anonymizeProxy,
    closeAnonymizedProxy,
    listenConnectAnonymizedProxy,
    createTunnel,
    closeTunnel,
};

module.exports = ProxyChain;
