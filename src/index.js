const { Server, RequestError } = require('./server');
const { parseUrl, redactUrl, redactParsedUrl } = require('./tools');
const { anonymizeProxy, closeAnonymizedProxy, listenConnectAnonymizedProxy } = require('./anonymize_proxy');
const { createTunnel, closeTunnel } = require('./tcp_tunnel_tools');

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
