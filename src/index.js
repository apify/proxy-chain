import { Server, RequestError } from './server';
import { parseUrl, redactUrl, redactParsedUrl } from './tools';
import { anonymizeProxy, closeAnonymizedProxy } from './anonymize_proxy';

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
};

module.exports = ProxyChain;
