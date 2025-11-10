/* eslint-disable no-console */
const { Server, generateCertificate } = require('..');

// This example demonstrates how to create an HTTPS proxy server with a self-signed certificate.
// The HTTPS proxy server works identically to the HTTP version but with TLS encryption.

(async () => {
    // Generate a self-signed certificate for development/testing
    // In production, you should use a proper certificate from a Certificate Authority
    console.log('Generating self-signed certificate...');
    const { key, cert } = generateCertificate({
        commonName: 'localhost',
        validityDays: 365,
        organization: 'Development',
    });

    console.log('Certificate generated successfully!');

    // Create an HTTPS proxy server
    const server = new Server({
        // Use HTTPS instead of HTTP
        serverType: 'https',

        // Provide the TLS certificate and private key
        httpsOptions: {
            key,
            cert,
        },

        // Port where the server will listen
        port: 8443,

        // Enable verbose logging to see what's happening
        verbose: true,

        // Optional: Add authentication and upstream proxy configuration
        prepareRequestFunction: ({ username, hostname, port }) => {
            console.log(`Request to ${hostname}:${port} from user: ${username || 'anonymous'}`);

            // Allow the request
            return {};
        },
    });

    // Handle failed HTTP/HTTPS requests
    server.on('requestFailed', ({ request, error }) => {
        console.log(`Request ${request.url} failed`);
        console.error(error);
    });

    // Handle TLS handshake errors
    server.on('tlsError', ({ error, socket }) => {
        console.error(`TLS error from ${socket.remoteAddress}: ${error.message}`);
    });

    // Emitted when HTTP/HTTPS connection is closed
    server.on('connectionClosed', ({ connectionId, stats }) => {
        console.log(`Connection ${connectionId} closed`);
        console.dir(stats);
    });

    // Start the server
    await server.listen();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\nShutting down server...');
        await server.close(true);
        console.log('Server closed.');
        process.exit(0);
    });

    // Keep the server running
    await new Promise(() => { });
})();
