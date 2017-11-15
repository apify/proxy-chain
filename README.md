# proxy-chain

[![npm version](https://badge.fury.io/js/proxy-chain.svg)](http://badge.fury.io/js/proxy-chain)
[![Build Status](https://travis-ci.org/Apifier/proxy-chain.svg)](https://travis-ci.org/Apifier/proxy-chain)

Node.js implementation of a proxy server (think Squid) with support for SSL, authentication and upstream proxy chaining.

For example, this library is useful if you need to use proxies with authentication
in the headless Chrome web browser, but don't feel like setting up Squid or some other proxy server.
The authentication and proxy chaining configuration is provided in code and can be dynamic.

## Run a simple HTTP/HTTPS proxy server

```javascript
const ProxyChain = require('proxy-chain');

const server = new ProxyChain.Server({ port: 8000 });

server.listen(() => {
    console.log(`Proxy server is listening on port ${8000}`);
});
```

## Run a HTTP/HTTPS proxy server with credentials and upstream proxy

```javascript
const ProxyChain = require('proxy-chain');

const server = new ProxyChain.Server({
    // Port where the server the server will listen. By default 8000.
    port: 8000,

    // Enables verbose logging
    verbose: true,

    // Custom function to authenticate proxy requests and provide the URL to chained upstream proxy.
    // It must return an object (or promise resolving to the object) with following form:
    // { requestAuthentication: Boolean, upstreamProxyUrl: String }
    // If the function is not defined or is null, the server runs in a simple mode.
    prepareRequestFunction: ({ request, username, password, hostname, port, isHttp }) => {
        return {
            // Require clients to authenticate with username 'bob' and password 'TopSecret'
            requestAuthentication: username !== 'bob' || password !== 'TopSecret',

            // Sets up an upstream HTTP proxy to which all the requests are forwarded.
            // If null, the proxy works in direct mode.
            upstreamProxyUrl: `http://username:password@proxy.example.com:3128`,
        };
    },
});

server.listen(() => {
  console.log(`Proxy server is listening on port ${8000}`);
});
```
