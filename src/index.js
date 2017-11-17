import { Server } from './server';
import { parseUrl, redactUrl, redactParsedUrl } from './tools';
import { anonymizeProxy, closeAnonymizedProxy } from './anonymize_proxy';

/* globals module */

// Publicly exported functions and classes
const ProxyChain = {
    Server,
    parseUrl,
    redactUrl,
    redactParsedUrl,
    anonymizeProxy,
    closeAnonymizedProxy,
};

module.exports = ProxyChain;
