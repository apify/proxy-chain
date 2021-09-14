const { RequestError } = require('./request_error');
const { Server } = require('./server');
const { redactUrl } = require('./utils/redact_url');
const { anonymizeProxy, closeAnonymizedProxy, listenConnectAnonymizedProxy } = require('./anonymize_proxy');
const { createTunnel, closeTunnel } = require('./tcp_tunnel_tools');

// Publicly exported functions and classes
const ProxyChain = {
    Server,
    RequestError,
    redactUrl,
    anonymizeProxy,
    closeAnonymizedProxy,
    listenConnectAnonymizedProxy,
    createTunnel,
    closeTunnel,
};

module.exports = ProxyChain;
