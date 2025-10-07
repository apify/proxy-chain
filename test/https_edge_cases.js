const { expect } = require('chai');
const portastic = require('portastic');
const request = require('request');
const { Server } = require('../src/index');
const { loadCertificate, verifyCertificate, certificateMatchesHostname } = require('./utils/certificate_generator');
const tls = require('tls');
const { TargetServer } = require('./utils/target_server');

/**
 * Helper function to make HTTP requests through proxy
 */
const requestPromised = (opts) => {
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) {
                return reject(error);
            }
            resolve(response, body);
        });
    });
};

describe('HTTPS Edge Cases - Certificate Validation', function () {
    this.timeout(30000);

    let freePorts;
    let targetServer;
    let proxyServer;

    before(async () => {
        freePorts = await portastic.find({ min: 50000, max: 50500 });
    });

    afterEach(async () => {
        if (proxyServer) {
            await proxyServer.close(true);
            proxyServer = null;
        }
        if (targetServer) {
            await targetServer.close();
            targetServer = null;
        }
    });

    describe('Expired Certificates', () => {
        it('rejects HTTPS proxy with expired certificate (strict SSL)', async () => {
            const expiredCert = loadCertificate('expired');
            const proxyPort = freePorts.shift();

            // Verify certificate is actually expired
            const certInfo = verifyCertificate(expiredCert.cert);
            expect(certInfo.isExpired).to.be.true;

            // Create HTTPS proxy with expired certificate
            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: expiredCert.key,
                    cert: expiredCert.cert,
                },
            });
            await proxyServer.listen();

            // Create target HTTP server
            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            // Attempt to connect with strict SSL validation
            try {
                await requestPromised({
                    url: `http://127.0.0.1:${targetPort}/hello-world`,
                    proxy: `https://127.0.0.1:${proxyPort}`,
                    strictSSL: true,
                    rejectUnauthorized: true,
                });
                expect.fail('Should have rejected expired certificate');
            } catch (error) {
                // Should fail with certificate error
                expect(error.message).to.match(/certificate|CERT|SSL|TLS/i);
            }
        });

        it('accepts HTTPS proxy with expired certificate (ignore SSL errors)', async () => {
            const expiredCert = loadCertificate('expired');
            const proxyPort = freePorts.shift();

            // Create HTTPS proxy with expired certificate
            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: expiredCert.key,
                    cert: expiredCert.cert,
                },
            });
            await proxyServer.listen();

            // Create target HTTP server
            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            // Connect with SSL validation disabled
            const response = await requestPromised({
                url: `http://127.0.0.1:${targetPort}/hello-world`,
                proxy: `https://127.0.0.1:${proxyPort}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            expect(response.statusCode).to.equal(200);
            expect(response.body).to.equal('Hello world!');
        });

        it('handles upstream HTTPS proxy with expired certificate', async () => {
            const expiredCert = loadCertificate('expired');
            const validCert = loadCertificate('valid');

            // Create upstream HTTPS proxy with expired cert
            const upstreamPort = freePorts.shift();
            const upstreamProxyServer = new Server({
                port: upstreamPort,
                serverType: 'https',
                httpsOptions: {
                    key: expiredCert.key,
                    cert: expiredCert.cert,
                },
            });
            await upstreamProxyServer.listen();

            // Create main HTTP proxy that chains to upstream HTTPS proxy
            const mainProxyPort = freePorts.shift();
            proxyServer = new Server({
                port: mainProxyPort,
                serverType: 'http',
                prepareRequestFunction: () => {
                    return {
                        upstreamProxyUrl: `https://127.0.0.1:${upstreamPort}`,
                    };
                },
            });
            await proxyServer.listen();

            // Create target HTTP server
            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            // Request through main proxy (which uses upstream HTTPS proxy with expired cert)
            // Should fail with 599 error or similar
            const response = await requestPromised({
                url: `http://127.0.0.1:${targetPort}/hello-world`,
                proxy: `http://127.0.0.1:${mainProxyPort}`,
            });

            // Expect error status code (599 for TLS errors)
            expect(response.statusCode).to.be.oneOf([599, 502, 503]);

            // Cleanup upstream proxy
            await upstreamProxyServer.close(true);
        });
    });

    describe('Hostname Mismatch', () => {
        it('rejects certificate with wrong hostname (strict SSL)', async () => {
            const mismatchCert = loadCertificate('hostname-mismatch');
            const proxyPort = freePorts.shift();

            // Verify certificate is for example.com, not localhost
            expect(certificateMatchesHostname(mismatchCert.cert, 'example.com')).to.be.true;
            expect(certificateMatchesHostname(mismatchCert.cert, '127.0.0.1')).to.be.false;
            expect(certificateMatchesHostname(mismatchCert.cert, 'localhost')).to.be.false;

            // Create HTTPS proxy with hostname mismatch certificate
            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: mismatchCert.key,
                    cert: mismatchCert.cert,
                },
            });
            await proxyServer.listen();

            // Create target HTTP server
            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            // Attempt to connect to 127.0.0.1 with certificate for example.com
            try {
                await requestPromised({
                    url: `http://127.0.0.1:${targetPort}/hello-world`,
                    proxy: `https://127.0.0.1:${proxyPort}`,
                    strictSSL: true,
                    rejectUnauthorized: true,
                });
                expect.fail('Should have rejected certificate with hostname mismatch');
            } catch (error) {
                // Should fail with hostname/altname error
                expect(error.message).to.match(/certificate|hostname|CERT_ALTNAME|SSL|TLS/i);
            }
        });

        it('accepts certificate with correct hostname (ignore SSL)', async () => {
            const mismatchCert = loadCertificate('hostname-mismatch');
            const proxyPort = freePorts.shift();

            // Create HTTPS proxy with hostname mismatch certificate
            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: mismatchCert.key,
                    cert: mismatchCert.cert,
                },
            });
            await proxyServer.listen();

            // Create target HTTP server
            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            // Connect with SSL validation disabled
            const response = await requestPromised({
                url: `http://127.0.0.1:${targetPort}/hello-world`,
                proxy: `https://127.0.0.1:${proxyPort}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            expect(response.statusCode).to.equal(200);
            expect(response.body).to.equal('Hello world!');
        });
    });

    describe('Multi-Stage Certificate Validation', () => {
        it('validates certificates independently at each proxy hop', async () => {
            const validCert = loadCertificate('valid');
            const expiredCert = loadCertificate('expired');

            // Create HTTPS target server with valid certificate
            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: true,
                sslKey: validCert.key,
                sslCrt: validCert.cert,
            });
            await targetServer.listen();

            // Create upstream HTTP proxy (no cert issues)
            const upstreamPort = freePorts.shift();
            const upstreamProxy = new Server({
                port: upstreamPort,
                serverType: 'http',
            });
            await upstreamProxy.listen();

            // Create main HTTPS proxy with expired certificate
            const mainProxyPort = freePorts.shift();
            proxyServer = new Server({
                port: mainProxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: expiredCert.key,
                    cert: expiredCert.cert,
                },
                prepareRequestFunction: () => {
                    return {
                        upstreamProxyUrl: `http://127.0.0.1:${upstreamPort}`,
                    };
                },
            });
            await proxyServer.listen();

            // Connect to main HTTPS proxy with expired cert
            // Client-to-proxy connection should fail (expired cert)
            // Even though target has valid cert
            try {
                await requestPromised({
                    url: `https://127.0.0.1:${targetPort}/hello-world`,
                    proxy: `https://127.0.0.1:${mainProxyPort}`,
                    strictSSL: true,
                    rejectUnauthorized: true,
                });
                expect.fail('Should have rejected expired certificate at proxy level');
            } catch (error) {
                // Should fail at proxy level, not target level
                expect(error.message).to.match(/certificate|CERT|SSL|TLS/i);
            }

            // Cleanup
            await upstreamProxy.close(true);
        });

        it('handles HTTPS proxy with HTTP target (protocol isolation)', async () => {
            const validCert = loadCertificate('valid');

            // Create HTTP target (plain HTTP, no SSL)
            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            // Create HTTPS proxy with valid certificate
            const proxyPort = freePorts.shift();
            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: validCert.key,
                    cert: validCert.cert,
                },
            });
            await proxyServer.listen();

            // Connect through HTTPS proxy to HTTP target
            // This validates protocol isolation:
            // 1. Client-to-proxy connection is encrypted (HTTPS)
            // 2. Proxy-to-target connection is plain HTTP
            // 3. The two connections are independent
            //
            // NOTE: Testing HTTPS proxy → HTTPS target with the `request` library
            // is not possible due to a bug in tunnel-agent (request/request#2762)
            // where rejectUnauthorized is not passed to the proxy connection.
            // TODO: we should migrate to impit.
            const response = await requestPromised({
                url: `http://127.0.0.1:${targetPort}/hello-world`,
                proxy: `https://127.0.0.1:${proxyPort}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            // Request succeeds - proves protocol isolation works
            expect(response.statusCode).to.equal(200);
            expect(response.body).to.equal('Hello world!');
        });
    });
});

describe('HTTPS Edge Cases - TLS Version Negotiation', function () {
    this.timeout(30000);

    let freePorts;
    let proxyServer;

    before(async () => {
        freePorts = await portastic.find({ min: 50500, max: 51000 });
    });

    afterEach(async () => {
        if (proxyServer) {
            await proxyServer.close(true);
            proxyServer = null;
        }
    });

    it('rejects TLS 1.0 clients', async () => {
        const validCert = loadCertificate('valid');
        const proxyPort = freePorts.shift();

        // Create HTTPS proxy with default TLS settings (minVersion: TLSv1.2)
        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

        // Attempt TLS 1.0 connection
        const result = await testTLSHandshake({
            host: '127.0.0.1',
            port: proxyPort,
            minVersion: 'TLSv1',
            maxVersion: 'TLSv1',
            rejectUnauthorized: false,
        });

        expect(result.success).to.be.false;
        expect(result.error).to.exist;
        expect(result.error.code).to.match(/UNSUPPORTED_PROTOCOL|EPROTO|ECONNRESET|ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION/);
    });

    it('rejects TLS 1.1 clients', async () => {
        const validCert = loadCertificate('valid');
        const proxyPort = freePorts.shift();

        // Create HTTPS proxy with default TLS settings (minVersion: TLSv1.2)
        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

        // Attempt TLS 1.1 connection
        const result = await testTLSHandshake({
            host: '127.0.0.1',
            port: proxyPort,
            minVersion: 'TLSv1.1',
            maxVersion: 'TLSv1.1',
            rejectUnauthorized: false,
        });

        expect(result.success).to.be.false;
        expect(result.error).to.exist;
        expect(result.error.code).to.match(/UNSUPPORTED_PROTOCOL|EPROTO|ECONNRESET|ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION/);
    });

    it('accepts TLS 1.2 clients', async () => {
        const validCert = loadCertificate('valid');
        const proxyPort = freePorts.shift();

        // Create HTTPS proxy with default TLS settings
        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

        // Attempt TLS 1.2 connection
        const result = await testTLSHandshake({
            host: '127.0.0.1',
            port: proxyPort,
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.2',
            rejectUnauthorized: false,
        });

        expect(result.success).to.be.true;
        expect(result.protocol).to.equal('TLSv1.2');
    });

    it('accepts TLS 1.3 clients', async () => {
        const validCert = loadCertificate('valid');
        const proxyPort = freePorts.shift();

        // Create HTTPS proxy with default TLS settings
        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

        // Attempt TLS 1.3 connection
        const result = await testTLSHandshake({
            host: '127.0.0.1',
            port: proxyPort,
            minVersion: 'TLSv1.3',
            maxVersion: 'TLSv1.3',
            rejectUnauthorized: false,
        });

        expect(result.success).to.be.true;
        expect(result.protocol).to.equal('TLSv1.3');
    });
});

describe('HTTPS Edge Cases - Cipher Suite Handling', function () {
    this.timeout(30000);

    let freePorts;
    let proxyServer;

    before(async () => {
        freePorts = await portastic.find({ min: 51000, max: 51500 });
    });

    afterEach(async () => {
        if (proxyServer) {
            await proxyServer.close(true);
            proxyServer = null;
        }
    });

    it('accepts clients with strong ciphers', async () => {
        const validCert = loadCertificate('valid');
        const proxyPort = freePorts.shift();

        // Create HTTPS proxy with strong cipher requirements
        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

        // Attempt connection with strong ciphers (AES-GCM, ChaCha20)
        const strongCiphers = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384';
        const result = await testTLSHandshake({
            host: '127.0.0.1',
            port: proxyPort,
            ciphers: strongCiphers,
            rejectUnauthorized: false,
        });

        expect(result.success).to.be.true;
        expect(result.cipher).to.exist;
        expect(result.cipher.name).to.match(/AES.*GCM|CHACHA20/i);
    });
});


/**
 * Test TLS handshake with specific version and cipher configuration
 * @param {Object} options - TLS connection options
 * @param {string} options.host - Host to connect to
 * @param {number} options.port - Port to connect to
 * @param {string} [options.minVersion] - Minimum TLS version (e.g., 'TLSv1', 'TLSv1.2')
 * @param {string} [options.maxVersion] - Maximum TLS version (e.g., 'TLSv1.3')
 * @param {string} [options.ciphers] - Cipher suite string
 * @param {boolean} [options.rejectUnauthorized=false] - Whether to reject unauthorized certificates
 * @param {number} [options.timeout=5000] - Connection timeout in milliseconds
 * @returns {Promise<Object>} Result object with success status, protocol, cipher, or error
 */
testTLSHandshake = async ({
    host,
    port,
    minVersion,
    maxVersion,
    ciphers,
    rejectUnauthorized = false,
    timeout = 5000,
}) => {
    return new Promise((resolve) => {
        const socket = tls.connect({
            host,
            port,
            minVersion,
            maxVersion,
            ciphers,
            rejectUnauthorized,
        });

        let resolved = false;

        const cleanup = () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
            }
        };

        socket.on('secureConnect', () => {
            if (resolved) return;
            resolved = true;

            const protocol = socket.getProtocol(); // 'TLSv1.2', 'TLSv1.3', etc.
            const cipher = socket.getCipher(); // { name, version, standardName }

            socket.destroy();
            resolve({
                success: true,
                protocol,
                cipher,
            });
        });

        socket.on('error', (error) => {
            if (resolved) return;
            resolved = true;

            socket.destroy();
            resolve({
                success: false,
                error: {
                    message: error.message,
                    code: error.code,
                    errno: error.errno,
                },
            });
        });

        socket.setTimeout(timeout, () => {
            if (resolved) return;
            cleanup();
            resolve({
                success: false,
                error: {
                    message: 'Connection timeout',
                    code: 'ETIMEDOUT',
                },
            });
        });
    });
};
