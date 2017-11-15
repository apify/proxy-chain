import { Server } from './server';
import { parseUrl, redactUrl, redactParsedUrl } from './tools';

/* globals module */

// Publicly exported functions and classes
const ProxyChain = {
    Server,

    // Utility functions
    parseUrl,
    redactUrl,
    redactParsedUrl,
};

module.exports = ProxyChain;
