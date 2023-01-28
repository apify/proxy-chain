const { Server } = require('..');

const server = new Server({
    // Port where the server will listen. By default 8000.
    port: 8000,

    // Enables verbose logging
    verbose: true,

    // Custom user-defined function to authenticate incoming proxy requests,
    // and optionally provide the URL to chained upstream proxy.
    // The function must return an object (or promise resolving to the object) with the following signature:
    // { requestAuthentication: Boolean, upstreamProxyUrl: String }
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
    prepareRequestFunction: () => {
        return {
            // If set to true, the client is sent HTTP 407 resposne with the Proxy-Authenticate header set,
            // requiring Basic authentication. Here you can verify user credentials.
            // requestAuthentication: username !== 'bob' || password !== 'TopSecret',

            // Sets up an upstream HTTP proxy to which all the requests are forwarded.
            // If null, the proxy works in direct mode, i.e. the connection is forwarded directly
            // to the target server. This field is ignored if "requestAuthentication" is true.
            // The username and password must be URI-encoded.
            upstreamProxyUrl: `socks://localhost:9050`,

            // If "requestAuthentication" is true, you can use the following property
            // to define a custom error message to return to the client instead of the default "Proxy credentials required"
            failMsg: 'Bad username or password, please try again.',
        };
    },
});

server.listen(() => {
    console.log(`Proxy server is listening on port ${server.port}`);
});

// Emitted when HTTP connection is closed
server.on('connectionClosed', ({ connectionId, stats }) => {
    console.log(`Connection ${connectionId.toString()} closed`);
    console.dir(stats);
});

// Emitted when HTTP request fails
server.on('requestFailed', ({ request, error }) => {
    console.log(`Request ${request.url} failed`);
    console.error(error);
});
