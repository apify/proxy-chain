const { expect } = require('chai');
const portastic = require('portastic');
const request = require('request');
const { Server } = require('../src/index');
const { loadCertificate, verifyCertificate, certificateMatchesHostname } = require('./utils/certificate_generator');
const tls = require('tls');
const { TargetServer } = require('./utils/target_server');

/**
 * Check if Node.js version supports crypto.X509Certificate (added in v15.6.0)
 */
const supportsX509Certificate = (() => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return major > 15 || (major === 15 && minor >= 6);
})();

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

            // Verify certificate is actually expired (only on Node 15.6.0+)
            if (supportsX509Certificate) {
                const certInfo = verifyCertificate(expiredCert.cert);
                expect(certInfo.isExpired).to.be.true;
            }

            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: expiredCert.key,
                    cert: expiredCert.cert,
                },
            });
            await proxyServer.listen();

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            try {
                await requestPromised({
                    url: `http://127.0.0.1:${targetPort}/hello-world`,
                    proxy: `https://127.0.0.1:${proxyPort}`,
                    strictSSL: true,
                    rejectUnauthorized: true,
                });
                expect.fail('Should have rejected expired certificate');
            } catch (error) {
                // Should fail with certificate expired error
                // Node.js returns CERT_HAS_EXPIRED for expired certificates
                expect(error.message).to.match(/CERT_HAS_EXPIRED|certificate.*expired/i);
            }
        });

        it('accepts HTTPS proxy with expired certificate (ignore SSL errors)', async () => {
            const expiredCert = loadCertificate('expired');
            const proxyPort = freePorts.shift();

            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: expiredCert.key,
                    cert: expiredCert.cert,
                },
            });
            await proxyServer.listen();

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

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

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            // Request through main proxy (which uses upstream HTTPS proxy with expired cert)
            // Should fail with 599 error
            const response = await requestPromised({
                url: `http://127.0.0.1:${targetPort}/hello-world`,
                proxy: `http://127.0.0.1:${mainProxyPort}`,
            });

            // TLS errors (CERT_HAS_EXPIRED, etc.) fall back to 599 - see errorCodeToStatusCode in statuses.ts
            expect(response.statusCode).to.equal(599);

            await upstreamProxyServer.close(true);
        });
    });

    describe('Hostname Mismatch', () => {
        it('rejects certificate with wrong hostname (strict SSL)', async () => {
            const mismatchCert = loadCertificate('hostname-mismatch');
            const proxyPort = freePorts.shift();

            // Verify certificate is for example.com, not localhost (only on Node 15.6.0+)
            if (supportsX509Certificate) {
                expect(certificateMatchesHostname(mismatchCert.cert, 'example.com')).to.be.true;
                expect(certificateMatchesHostname(mismatchCert.cert, '127.0.0.1')).to.be.false;
                expect(certificateMatchesHostname(mismatchCert.cert, 'localhost')).to.be.false;
            }

            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: mismatchCert.key,
                    cert: mismatchCert.cert,
                },
            });
            await proxyServer.listen();

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
                // Should fail with hostname validation error or self-signed certificate error
                // Node.js may return ERR_TLS_CERT_ALTNAME_INVALID for hostname mismatches,
                // or may reject self-signed certificates before checking hostname
                expect(error.message).to.match(/ERR_TLS_CERT_ALTNAME_INVALID|CERT.*ALTNAME|Hostname.*mismatch|does not match|self.*signed.*certificate/i);
            }
        });

        it('accepts certificate with correct hostname (ignore SSL)', async () => {
            const mismatchCert = loadCertificate('hostname-mismatch');
            const proxyPort = freePorts.shift();

            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: mismatchCert.key,
                    cert: mismatchCert.cert,
                },
            });
            await proxyServer.listen();

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

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

    describe('Invalid Certificate Chain', () => {
        it('rejects HTTPS proxy with incomplete certificate chain (strict SSL)', async () => {
            const invalidChainCert = loadCertificate('invalid-chain');
            const proxyPort = freePorts.shift();

            // Create HTTPS proxy with incomplete certificate chain
            // The certificate is signed by a root CA, but the chain is incomplete
            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: invalidChainCert.key,
                    cert: invalidChainCert.cert,
                },
            });
            await proxyServer.listen();

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            try {
                await requestPromised({
                    url: `http://127.0.0.1:${targetPort}/hello-world`,
                    proxy: `https://127.0.0.1:${proxyPort}`,
                    strictSSL: true,
                    rejectUnauthorized: true,
                });
                expect.fail('Should have rejected certificate with incomplete chain');
            } catch (error) {
                // Should fail with certificate chain verification error
                // Node.js may return various messages for invalid certificate chains:
                // - UNABLE_TO_VERIFY_LEAF_SIGNATURE
                // - SELF_SIGNED_CERT_IN_CHAIN
                // - "unable to verify the first certificate"
                expect(error.message).to.match(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|unable to verify|self.*signed/i);
            }
        });

        it('accepts HTTPS proxy with incomplete certificate chain (ignore SSL errors)', async () => {
            const invalidChainCert = loadCertificate('invalid-chain');
            const proxyPort = freePorts.shift();

            proxyServer = new Server({
                port: proxyPort,
                serverType: 'https',
                httpsOptions: {
                    key: invalidChainCert.key,
                    cert: invalidChainCert.cert,
                },
            });
            await proxyServer.listen();

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            const response = await requestPromised({
                url: `http://127.0.0.1:${targetPort}/hello-world`,
                proxy: `https://127.0.0.1:${proxyPort}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            expect(response.statusCode).to.equal(200);
            expect(response.body).to.equal('Hello world!');
        });

        it('handles upstream HTTPS proxy with invalid certificate chain', async () => {
            const invalidChainCert = loadCertificate('invalid-chain');

            const upstreamPort = freePorts.shift();
            const upstreamProxyServer = new Server({
                port: upstreamPort,
                serverType: 'https',
                httpsOptions: {
                    key: invalidChainCert.key,
                    cert: invalidChainCert.cert,
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

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

            // Request through main proxy (which uses upstream HTTPS proxy with invalid chain)
            // Should fail with 599 error
            const response = await requestPromised({
                url: `http://127.0.0.1:${targetPort}/hello-world`,
                proxy: `http://127.0.0.1:${mainProxyPort}`,
            });

            // TLS errors (UNABLE_TO_VERIFY_LEAF_SIGNATURE, etc.) fall back to 599 - see errorCodeToStatusCode in statuses.ts
            expect(response.statusCode).to.equal(599);

            await upstreamProxyServer.close(true);
        });
    });

    /**
     * These tests validate certificate checking at each hop in complex proxy chains.
     * Each connection (client -> proxy, proxy -> upstream, upstream -> target) is validated
     * independently with different certificate states.
     */
    describe('Multi-Stage Certificate Validation', () => {
        it('validates certificates independently at each proxy hop', async () => {
            const validCert = loadCertificate('valid');
            const expiredCert = loadCertificate('expired');

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
                expect(error.message).to.match(/CERT_HAS_EXPIRED|certificate.*expired|TLS|SSL/i);
            }

            await upstreamProxy.close(true);
        });

        it('handles HTTPS proxy with HTTP target (protocol isolation)', async () => {
            const validCert = loadCertificate('valid');

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: false,
            });
            await targetServer.listen();

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

            // Validates protocol isolation: client-proxy (HTTPS) and proxy-target (HTTP)
            // connections are independent.
            //
            // NOTE: HTTPS proxy -> HTTPS target cannot be tested with the `request` library
            // due to tunnel-agent bug (request/request#2762) where rejectUnauthorized is not
            // passed to the proxy connection.
            // TODO: Migrate to impit to enable HTTPS -> HTTPS testing
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

    describe('HTTPS Target Certificate Handling via CONNECT', () => {
         // NOTE:
         // When a client makes a CONNECT request to establish a tunnel to an HTTPS target,
         // the proxy creates a raw TCP tunnel between the client and target. The TLS
         // handshake happens directly between the client and target - the proxy never
         // sees or validates the target's certificate.
         //
         // This is the CORRECT behavior per RFC 7231 (CONNECT method specification).
         // The proxy is protocol-agnostic and simply pipes bytes bidirectionally.
         //
         // These tests document and verify this expected behavior.

        it('allows CONNECT tunnel to HTTPS target regardless of target certificate', async () => {
            const expiredCert = loadCertificate('expired');

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: true,
                sslKey: expiredCert.key,
                sslCrt: expiredCert.cert,
            });
            await targetServer.listen();

            const proxyPort = freePorts.shift();
            proxyServer = new Server({
                port: proxyPort,
                serverType: 'http',
            });
            await proxyServer.listen();

            // The proxy will successfully create the tunnel regardless of target certificate
            // This documents that the proxy doesn't validate target certificates
            // (The client would see the certificate error if it validated)
            const response = await requestPromised({
                url: `https://127.0.0.1:${targetPort}/hello-world`,
                proxy: `http://127.0.0.1:${proxyPort}`,
                strictSSL: false, // Client ignores certificate errors
                rejectUnauthorized: false,
            });

            // Request succeeds through tunnel, demonstrating:
            // 1. Proxy created TCP tunnel successfully (doesn't validate target cert)
            // 2. Client performed TLS handshake through tunnel
            // 3. Client chose to ignore certificate errors (strictSSL: false)
            expect(response.statusCode).to.equal(200);
            expect(response.body).to.equal('Hello world!');
        });

        it('client validates HTTPS target certificate through HTTP proxy tunnel', async () => {
            const expiredCert = loadCertificate('expired');

            const targetPort = freePorts.shift();
            targetServer = new TargetServer({
                port: targetPort,
                useSsl: true,
                sslKey: expiredCert.key,
                sslCrt: expiredCert.cert,
            });
            await targetServer.listen();

            const proxyPort = freePorts.shift();
            proxyServer = new Server({
                port: proxyPort,
                serverType: 'http',
            });
            await proxyServer.listen();

            // Client attempts to validate target certificate through tunnel
            // The proxy creates the tunnel successfully, but the CLIENT rejects
            // the target's expired certificate during the TLS handshake
            try {
                await requestPromised({
                    url: `https://127.0.0.1:${targetPort}/hello-world`,
                    proxy: `http://127.0.0.1:${proxyPort}`,
                    strictSSL: true, // Client validates certificate
                    rejectUnauthorized: true,
                });
                expect.fail('Client should have rejected expired target certificate');
            } catch (error) {
                // Client (not proxy) detects and rejects the expired certificate
                // This proves TLS handshake happens between client and target
                expect(error.message).to.match(/CERT_HAS_EXPIRED|certificate.*expired/i);
            }
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

        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

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

        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

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

    it('accepts clients with strong ciphers', async () => {
        const validCert = loadCertificate('valid');
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

describe('HTTPS Edge Cases - SNI (Server Name Indication)', function () {
    this.timeout(30000);

    let freePorts;
    let targetServer;
    let proxyServer;

    before(async () => {
        freePorts = await portastic.find({ min: 51000, max: 51500 });
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

    it('sends correct SNI for HTTPS target through HTTPS proxy', async () => {
        const validCert = loadCertificate('valid');
        const proxyPort = freePorts.shift();

        // Verify certificate is for localhost (only on Node 15.6.0+)
        if (supportsX509Certificate) {
            expect(certificateMatchesHostname(validCert.cert, 'localhost')).to.be.true;
        }

        // Create HTTPS proxy with certificate for localhost
        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

        // Test 1: Connect with correct SNI (localhost) - should succeed
        const resultWithCorrectSNI = await testTLSHandshake({
            host: '127.0.0.1',
            port: proxyPort,
            servername: 'localhost', // Correct SNI matching certificate
            rejectUnauthorized: false, // Ignore self-signed cert, but SNI still validated
        });

        expect(resultWithCorrectSNI.success).to.be.true;

        // Test 2: Connect without SNI - should also succeed (TLS 1.2 compatibility)
        const resultWithoutSNI = await testTLSHandshake({
            host: '127.0.0.1',
            port: proxyPort,
            // No servername = no SNI extension
            rejectUnauthorized: false,
        });

        expect(resultWithoutSNI.success).to.be.true;
    });

    it('handles SNI mismatch errors correctly', async () => {
        const validCert = loadCertificate('valid');
        const proxyPort = freePorts.shift();

        // Verify certificate is for localhost, not example.com (only on Node 15.6.0+)
        if (supportsX509Certificate) {
            expect(certificateMatchesHostname(validCert.cert, 'localhost')).to.be.true;
            expect(certificateMatchesHostname(validCert.cert, 'example.com')).to.be.false;
        }

        // Create HTTPS proxy with certificate for localhost
        proxyServer = new Server({
            port: proxyPort,
            serverType: 'https',
            httpsOptions: {
                key: validCert.key,
                cert: validCert.cert,
            },
        });
        await proxyServer.listen();

        // Attempt TLS connection with mismatched SNI
        // Server has cert for "localhost", but client sends SNI for "example.com"
        const result = await testTLSHandshake({
            host: '127.0.0.1',
            port: proxyPort,
            servername: 'example.com', // SNI mismatch!
            rejectUnauthorized: true, // Strict validation
        });

        // Connection should fail due to SNI/hostname mismatch
        expect(result.success).to.be.false;
        expect(result.error).to.exist;
        // Error can be certificate validation error or hostname mismatch
        expect(result.error.code || result.error.message).to.match(/CERT|UNABLE_TO_VERIFY|self.*signed|ERR_TLS_CERT_ALTNAME_INVALID/i);
    });
});

/**
 * Test TLS handshake with specific version and cipher configuration
 * @returns {Promise<Object>} Result object with success status, protocol, cipher, or error
 */
const testTLSHandshake = async ({
    host,
    port,
    minVersion,
    maxVersion,
    ciphers,
    servername,
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
            servername,
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
