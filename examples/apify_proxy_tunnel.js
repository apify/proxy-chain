const { createTunnel, closeTunnel, redactUrl } = require('proxy-chain');

// This example demonstrates how to create a tunnel via Apify's HTTP proxy service.
// For details, see https://blog.apify.com/tunneling-arbitrary-protocols-over-http-proxy-with-static-ip-address-b3a2222191ff

(async () => {
    // Select the proxy to tunnel through. Note that some proxies do not allow
    // HTTP traffic (port 80) over the HTTP CONNECT tunnel, or might not allow connection
    // to target on any other port than 80 (HTTP) or 443 (HTTPS).
    // You might want to try different proxy groups.
    const PROXY_URL = 'http://auto:<PROXY_PASSWORD>@proxy.apify.com:8000';

    // Target server to connect to. Here we use www.example.com and port 443 for HTTPS.
    // You can use any other host and port.
    const TARGET_HOST = 'www.example.com:443';

    // Create tunnel for the service, this call will start local tunnel and
    // return a string in format localhost:<selected-port>.
    // Here we set "port" to 9999, but you can use 0 to get a random port.
    // The "verbose" option causes a lot of logging
    const tunnelInfo = await createTunnel(PROXY_URL, TARGET_HOST, { port: 9999, verbose: true });

    console.log(`Tunnel to ${TARGET_HOST} via ${redactUrl(PROXY_URL)} established at ${tunnelInfo}...`);

    // Here we assume por 443 from above, otherwise the service will not be accessible via HTTPS!
    console.log(`To test it, you can run: curl --verbose https://${tunnelInfo}`);

    // Wait forever...
    await new Promise(() => {});

    // Normally, you'd also want to close the tunnel and all open connections
    await closeTunnel(tunnelInfo, true);
})();
