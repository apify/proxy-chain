# Programmable HTTP proxy server for Node.js

[![npm version](https://badge.fury.io/js/proxy-chain.svg)](http://badge.fury.io/js/proxy-chain)

A programmable proxy server (think Squid) with support for SSL/TLS, authentication, upstream proxy chaining, SOCKS4/5 protocol,
custom HTTP responses, and traffic statistics.
The authentication and proxy chaining configuration is defined in code and can be fully dynamic, giving you a high level of customization for your use case.

For example, the proxy-chain package is useful if you need to use headless Chrome web browser and proxies with authentication,
because Chrome doesn't support proxy URLs with password, such as `http://username:password@proxy.example.com:8080`.
With this package, you can set up a local proxy server without any password
that will forward requests to the upstream proxy with password.
For details, read [How to make headless Chrome and Puppeteer use a proxy server with authentication](https://blog.apify.com/how-to-make-headless-chrome-and-puppeteer-use-a-proxy-server-with-authentication-249a21a79212/).

The proxy-chain package is developed by [Apify](https://apify.com/), the full-stack web scraping and data extraction platform, to support their [Apify Proxy](https://apify.com/proxy) product,
which provides an easy access to a large pool of datacenter and residential IP addresses all around the world. The proxy-chain package is also used by [Crawlee](https://crawlee.dev/),
the world's most popular web craling library for Node.js.

The proxy-chain package currently supports HTTP/SOCKS forwarding and HTTP CONNECT tunneling to forward arbitrary protocols such as HTTPS or FTP ([learn more](https://blog.apify.com/tunneling-arbitrary-protocols-over-http-proxy-with-static-ip-address-b3a2222191ff)). The HTTP CONNECT tunneling also supports the SOCKS protocol. Also, proxy-chain only supports the Basic [Proxy-Authorization](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Proxy-Authorization).

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
    // Port where the server will listen. By default 8000.
    port: 8000,

    // Optional host where the proxy server will listen.
    // If not specified, the sever listens on an unspecified IP address (0.0.0.0 in IPv4, :: in IPv6)
    // You can use this option to limit the access to the proxy server.
    host: 'localhost',

    // Enables verbose logging
    verbose: true,

    // Custom user-defined function to authenticate incoming proxy requests,
    // and optionally provide the URL to chained upstream proxy.
    // The function must return an object (or promise resolving to the object) with the following signature:
    // { requestAuthentication: boolean, upstreamProxyUrl: string, failMsg?: string, customTag?: unknown }
    // If the function is not defined or is null, the server runs in simple mode.
    // Note that the function takes a single argument with the following properties:
    // * request      - An instance of http.IncomingMessage class with information about the client request
    //                  (which is either HTTP CONNECT for SSL protocol, or other HTTP request)
    // * username     - Username parsed from the Proxy-Authorization header. Might be empty string.
    // * password     - Password parsed from the Proxy-Authorization header. Might be empty string.
    // * hostname     - Hostname of the target server
    // * port         - Port of the target server
    // * isHttp       - If true, this is a HTTP request, otherwise it's a HTTP CONNECT tunnel for SSL
    //                  or other protocols
    // * connectionId - Unique ID of the HTTP connection. It can be used to obtain traffic statistics.
    prepareRequestFunction: ({ request, username, password, hostname, port, isHttp, connectionId }) => {
        return {
            // If set to true, the client is sent HTTP 407 resposne with the Proxy-Authenticate header set,
            // requiring Basic authentication. Here you can verify user credentials.
            requestAuthentication: username !== 'bob' || password !== 'TopSecret',

            // Sets up an upstream HTTP/SOCKS proxy to which all the requests are forwarded.
            // If null, the proxy works in direct mode, i.e. the connection is forwarded directly
            // to the target server. This field is ignored if "requestAuthentication" is true.
            // The username and password must be URI-encoded.
            upstreamProxyUrl: `http://username:password@proxy.example.com:3128`,
            // Or use SOCKS4/5 proxy, e.g.
            // upstreamProxyUrl: `socks://username:password@proxy.example.com:1080`,

            // If "requestAuthentication" is true, you can use the following property
            // to define a custom error message to return to the client instead of the default "Proxy credentials required"
            failMsg: 'Bad username or password, please try again.',

            // Optional custom tag that will be passed back via
            // `tunnelConnectResponded` or `tunnelConnectFailed` events
            // Can be used to pass information between proxy-chain
            // and any external code or application using it
            customTag: { userId: '123' },
        };
    },
});

server.listen(() => {
  console.log(`Proxy server is listening on port ${server.port}`);
});

// Emitted when HTTP connection is closed
server.on('connectionClosed', ({ connectionId, stats }) => {
  console.log(`Connection ${connectionId} closed`);
  console.dir(stats);
});

// Emitted when HTTP request fails
server.on('requestFailed', ({ request, error }) => {
  console.log(`Request ${request.url} failed`);
  console.error(error);
});
```

## SOCKS support
SOCKS protocol is supported for versions 4 and 5, specifically: `['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']`, where `socks` will default to version 5.

You can use an `upstreamProxyUrl` like `socks://username:password@proxy.example.com:1080`.

## Error status codes

The `502 Bad Gateway` HTTP status code is not comprehensive enough. Therefore, the server may respond with `590-599` instead:

### `590 Non Successful`

Upstream responded with non-200 status code.

### `591 RESERVED`

*This status code is reserved for further use.*

### `592 Status Code Out Of Range`

Upstream respondend with status code different than 100-999.

### `593 Not Found`

DNS lookup failed - [`EAI_NODATA`](https://github.com/libuv/libuv/blob/cdbba74d7a756587a696fb3545051f9a525b85ac/include/uv.h#L82) or [`EAI_NONAME`](https://github.com/libuv/libuv/blob/cdbba74d7a756587a696fb3545051f9a525b85ac/include/uv.h#L83).

### `594 Connection Refused`

Upstream refused connection.

### `595 Connection Reset`

Connection reset due to loss of connection or timeout.

### `596 Broken Pipe`

Trying to write on a closed socket.

### `597 Auth Failed`

Incorrect upstream credentials.

### `598 RESERVED`

*This status code is reserved for further use.*

### `599 Upstream Error`

Generic upstream error.

---

`590` and `592` indicate an issue on the upstream side. \
`593` indicates an incorrect `proxy-chain` configuration.\
`594`, `595` and `596` may occur due to connection loss.\
`597` indicates incorrect upstream credentials.\
`599` is a generic error, where the above is not applicable.

## Custom error responses

To return a custom HTTP response to indicate an error to the client,
you can throw the `RequestError` from inside of the `prepareRequestFunction` function.
The class constructor has the following parameters: `RequestError(body, statusCode, headers)`.
By default, the response will have `Content-Type: text/plain; charset=utf-8`.

```javascript
const ProxyChain = require('proxy-chain');

const server = new ProxyChain.Server({
    prepareRequestFunction: ({ request, username, password, hostname, port, isHttp, connectionId }) => {
        if (username !== 'bob') {
           throw new ProxyChain.RequestError('Only Bob can use this proxy!', 400);
        }
    },
});
```

## Measuring traffic statistics

To get traffic statistics for a certain HTTP connection, you can use:
```javascript
const stats = server.getConnectionStats(connectionId);
console.dir(stats);
```

The resulting object looks like:
```javascript
{
    // Number of bytes sent to client
    srcTxBytes: Number,
    // Number of bytes received from client
    srcRxBytes: Number,
    // Number of bytes sent to target server (proxy or website)
    trgTxBytes: Number,
    // Number of bytes received from target server (proxy or website)
    trgRxBytes: Number,
}
```

If the underlying sockets were closed, the corresponding values will be `null`,
rather than `0`.

## Custom responses

Custom responses allow you to override the response to a HTTP requests to the proxy, without contacting any target host.
For example, this is useful if you want to provide a HTTP proxy-style interface
to an external API or respond with some custom page to certain requests.
Note that this feature is only available for HTTP connections. That's because HTTPS
connections cannot be intercepted without access to the target host's private key.

To provide a custom response, the result of the `prepareRequestFunction` function must
define the `customResponseFunction` property, which contains a function that generates the custom response.
The function is passed no parameters and it must return an object (or a promise resolving to an object)
with the following properties:

```javascript
{
  // Optional HTTP status code of the response. By default it is 200.
  statusCode: 200,

  // Optional HTTP headers of the response
  headers: {
    'X-My-Header': 'bla bla',
  }

  // Optional string with the body of the HTTP response
  body: 'My custom response',

  // Optional encoding of the body. If not provided, defaults to 'UTF-8'
  encoding: 'UTF-8',
}
```

Here is a simple example:

```javascript
const ProxyChain = require('proxy-chain');

const server = new ProxyChain.Server({
    port: 8000,
    prepareRequestFunction: ({ request, username, password, hostname, port, isHttp }) => {
        return {
            customResponseFunction: () => {
                return {
                    statusCode: 200,
                    body: `My custom response to ${request.url}`,
                };
            },
        };
    },
});

server.listen(() => {
  console.log(`Proxy server is listening on port ${server.port}`);
});
```

## Routing CONNECT to another HTTP server

While `customResponseFunction` enables custom handling methods such as `GET` and `POST`, many HTTP clients rely on `CONNECT` tunnels.
It's possible to route those requests differently using the `customConnectServer` option. It accepts an instance of Node.js HTTP server.

```javascript
const http = require('http');
const ProxyChain = require('proxy-chain');

const exampleServer = http.createServer((request, response) => {
    response.end('Hello from a custom server!');
});

const server = new ProxyChain.Server({
    port: 8000,
    prepareRequestFunction: ({ request, username, password, hostname, port, isHttp }) => {
        if (request.url.toLowerCase() === 'example.com:80') {
            return {
                customConnectServer: exampleServer,
            };
        }

        return {};
    },
});

server.listen(() => {
  console.log(`Proxy server is listening on port ${server.port}`);
});
```

In the example above, all CONNECT tunnels to `example.com` are overridden.
This is an unsecure server, so it accepts only `http:` requests.

In order to intercept `https:` requests, `https.createServer` should be used instead, along with a self signed certificate.

```javascript
const https = require('https');
const fs = require('fs');
const key = fs.readFileSync('./test/ssl.key');
const cert = fs.readFileSync('./test/ssl.crt');

const exampleServer = https.createServer({
    key,
    cert,
}, (request, response) => {
    response.end('Hello from a custom server!');
});
```

## Closing the server

To shut down the proxy server, call the `close([destroyConnections], [callback])` function. For example:

```javascript
server.close(true, () => {
  console.log('Proxy server was closed.');
});
```

The `closeConnections` parameter indicates whether pending proxy connections should be forcibly closed.
If it's `false`, the function will wait until all connections are closed, which can take a long time.
If the `callback` parameter is omitted, the function returns a promise.


## Accessing the CONNECT response headers for proxy tunneling

Some upstream proxy providers might include valuable debugging information in the CONNECT response
headers when establishing the proxy tunnel, for they may not modify future data in the tunneled
connection.

The proxy server would emit a `tunnelConnectResponded` event for exposing such information, where
the parameter types of the event callback are described in [Node.js's documentation][1]. Example:

[1]: https://nodejs.org/api/http.html#http_event_connect

```javascript
server.on('tunnelConnectResponded', ({ proxyChainId, response, socket, head, customTag }) => {
    console.log(`CONNECT response headers received: ${response.headers}`);
});
```

Alternatively a [helper function](##helper-functions) may be used:

```javascript
listenConnectAnonymizedProxy(anonymizedProxyUrl, ({ response, socket, head }) => {
    console.log(`CONNECT response headers received: ${response.headers}`);
});
```

You can also listen to CONNECT requests that receive response with status code different from 200.
The proxy server would emit a `tunnelConnectFailed` event.

```javascript
server.on('tunnelConnectFailed', ({ proxyChainId, response, socket, head, customTag }) => {
    console.log(`CONNECT response failed with status code: ${response.statusCode}`);
});
```

## Helper functions

The package also provides several utility functions.


### `anonymizeProxy({ url, port }, callback)`

Parses and validates a HTTP proxy URL. If the proxy requires authentication,
then the function starts an open local proxy server that forwards to the proxy.
The port (on which the local proxy server will start) can be set via the `port` property of the first argument, if not provided, it will be chosen randomly.

The function takes an optional callback that receives the anonymous proxy URL.
If no callback is supplied, the function returns a promise that resolves to a String with
anonymous proxy URL or the original URL if it was already anonymous.

The following example shows how you can use a proxy with authentication
from headless Chrome and [Puppeteer](https://github.com/GoogleChrome/puppeteer).
For details, read this [blog post](https://blog.apify.com/how-to-make-headless-chrome-and-puppeteer-use-a-proxy-server-with-authentication-249a21a79212).

```javascript
const puppeteer = require('puppeteer');
const proxyChain = require('proxy-chain');

(async() => {
    const oldProxyUrl = 'http://bob:password123@proxy.example.com:8000';
    const newProxyUrl = await proxyChain.anonymizeProxy(oldProxyUrl);

    // Prints something like "http://127.0.0.1:45678"
    console.log(newProxyUrl);

    const browser = await puppeteer.launch({
        args: [`--proxy-server=${newProxyUrl}`],
    });

    // Do your magic here...
    const page = await browser.newPage();
    await page.goto('https://www.example.com');
    await page.screenshot({ path: 'example.png' });
    await browser.close();

    // Clean up
    await proxyChain.closeAnonymizedProxy(newProxyUrl, true);
})();
```

### `closeAnonymizedProxy(anonymizedProxyUrl, closeConnections, callback)`

Closes anonymous proxy previously started by `anonymizeProxy()`.
If proxy was not found or was already closed, the function has no effect
and its result is `false`. Otherwise the result is `true`.

The `closeConnections` parameter indicates whether pending proxy connections are forcibly closed.
If it's `false`, the function will wait until all connections are closed, which can take a long time.

The function takes an optional callback that receives the result Boolean from the function.
If callback is not provided, the function returns a promise instead.

### `createTunnel(proxyUrl, targetHost, options, callback)`

Creates a TCP tunnel to `targetHost` that goes through a HTTP proxy server
specified by the `proxyUrl` parameter.

The optional `options` parameter is an object with the following properties:
- `port: Number` - Enables specifying the local port to listen at. By default `0`,
   which means a random port will be selected.
- `hostname: String` - Local hostname to listen at. By default `localhost`.
- `verbose: Boolean` - If `true`, the functions logs a lot. By default `false`.

The result of the function is a local endpoint in a form of `hostname:port`.
All TCP connections made to the local endpoint will be tunneled through the proxy to the target host and port.
For example, this is useful if you want to access a certain service from a specific IP address.

The tunnel should be eventually closed by calling the `closeTunnel()` function.

The `createTunnel()` function accepts an optional Node.js-style callback that receives the path to the local endpoint.
If no callback is supplied, the function returns a promise that resolves to a String with
the path to the local endpoint.

For more information, read this [blog post](https://blog.apify.com/tunneling-arbitrary-protocols-over-http-proxy-with-static-ip-address-b3a2222191ff).

Example:

```javascript
const host = await createTunnel('http://bob:pass123@proxy.example.com:8000', 'service.example.com:356');
// Prints something like "localhost:56836"
console.log(host);
```

### `closeTunnel(tunnelString, closeConnections, callback)`

Closes tunnel previously started by `createTunnel()`.
The result value is `false` if the tunnel was not found or was already closed, otherwise it is `true`.

The `closeConnections` parameter indicates whether pending connections are forcibly closed.
If it's `false`, the function will wait until all connections are closed, which can take a long time.

The function takes an optional callback that receives the result of the function.
If the callback is not provided, the function returns a promise instead.

### `listenConnectAnonymizedProxy(anonymizedProxyUrl, tunnelConnectRespondedCallback)`

Allows to configure a callback on the anonymized proxy URL for the CONNECT response headers. See the
above section [Accessing the CONNECT response headers for proxy tunneling](#accessing-the-connect-response-headers-for-proxy-tunneling)
for details.

### `redactUrl(url, passwordReplacement)`

Takes a URL and hides the password from it. For example:

```javascript
// Prints 'http://bob:<redacted>@example.com'
console.log(redactUrl('http://bob:pass123@example.com'));
```
