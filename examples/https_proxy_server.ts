import { Server, generateCertificate } from '../src';

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

            // Example: Require authentication
            // if (!username || !password) {
            //     return {
            //         requestAuthentication: true,
            //         failMsg: 'Proxy credentials required',
            //     };
            // }

            // Example: Use upstream proxy
            // return {
            //     upstreamProxyUrl: 'http://upstream-proxy.example.com:8000',
            // };

            // Allow the request
            return {};
        },
    });

    // Start the server
    await server.listen();

    console.log('\n======================================');
    console.log(`HTTPS Proxy server is running on port ${server.port}`);
    console.log('======================================\n');

    console.log('To test the HTTPS proxy server, you can use:');
    console.log('\n1. With curl (ignoring self-signed certificate):');
    console.log(`   curl --proxy-insecure -x https://localhost:${server.port} -k http://example.com\n`);

    console.log('2. Configure your browser to use HTTPS proxy:');
    console.log(`   - Proxy: localhost`);
    console.log(`   - Port: ${server.port}`);
    console.log(`   - Type: HTTPS`);
    console.log('   - Note: Browser may warn about self-signed certificate\n');

    console.log('3. With Node.js https agent:');
    console.log('   const agent = new HttpsProxyAgent(');
    console.log(`     'https://localhost:${server.port}',`);
    console.log('     { rejectUnauthorized: false } // for self-signed cert');
    console.log('   );\n');

    console.log('Press Ctrl+C to stop the server...\n');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\nShutting down server...');
        await server.close(true);
        console.log('Server closed.');
        process.exit(0);
    });

    // Keep the server running
    await new Promise(() => {});
})();
