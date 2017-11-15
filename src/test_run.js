const ProxyChain = require('./index');

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
            //upstreamProxyUrl: `http://username:password@proxy.example.com:3128`,
        };
    },
});

server.listen(() => {
    console.log(`Proxy server is listening on port ${8000}`);
});