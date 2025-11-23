const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { expect } = require('chai');
const portastic = require('portastic');
const request = require('request');
const sinon = require('sinon');
const WebSocket = require('ws');
const socksv5 = require('socksv5');

const { Server } = require('../src/index');
const { TargetServer } = require('./utils/target_server');

// Enable self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sslKey = fs.readFileSync(path.join(__dirname, 'ssl.key'));
const sslCrt = fs.readFileSync(path.join(__dirname, 'ssl.crt'));

const requestPromised = (opts) => {
    return new Promise((resolve, reject) => {
        request(opts, (error, response, body) => {
            if (error) {
                return reject(error);
            }
            resolve({ response, body });
        });
    });
};

const wait = (timeout) => new Promise((resolve) => setTimeout(resolve, timeout));

/**
 * Helper class: HTTP server that sends responses in controllable chunks.
 * Enables stats queries at specific lifecycle points during transfer.
 */
class ChunkedTargetServer {
    constructor({ port, chunks, delayBetweenChunks = 500 }) {
        this.port = port;
        this.chunks = chunks;
        this.delayBetweenChunks = delayBetweenChunks;
        this.server = null;
    }

    async listen() {
        const http = require('http');
        this.server = http.createServer(async (_, res) => {
            // Calculate total size for Content-Length header
            const totalSize = this.chunks.reduce((sum, chunk) => {
                const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
                return sum + size;
            }, 0);

            res.writeHead(200, {
                'Content-Type': 'text/plain',
                'Content-Length': totalSize,
            });

            // Send chunks with delays
            for (let i = 0; i < this.chunks.length; i++) {
                res.write(this.chunks[i]);

                // Add delay between chunks (but not after last chunk)
                if (i < this.chunks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, this.delayBetweenChunks));
                }
            }

            res.end();
        });

        await new Promise((resolve) => this.server.listen(this.port, resolve));
    }

    async close() {
        if (this.server) {
            await new Promise((resolve) => this.server.close(resolve));
        }
    }

    get address() {
        return this.server ? this.server.address() : null;
    }
}

/**
 * Captures a snapshot of connection stats at a specific moment.
 * Returns null if connection doesn't exist.
 */
function captureStatsSnapshot(server, connectionId, label) {
    const stats = server.getConnectionStats(connectionId);
    if (!stats) return null;

    return {
        label,
        timestamp: Date.now(),
        srcTxBytes: stats.srcTxBytes,
        srcRxBytes: stats.srcRxBytes,
        trgTxBytes: stats.trgTxBytes,
        trgRxBytes: stats.trgRxBytes,
    };
}

/**
 * Creates HTTPS agent with TLS session caching disabled.
 */
function createNonCachingAgent(extraOptions = {}) {
    return new https.Agent({
        maxCachedSessions: 0,
        ...extraOptions,
    });
}

/**
 * Captures connection statistics when connection closes.
 */
function awaitConnectionStats(server) {
    return new Promise((resolve) => {
        server.once('connectionClosed', ({ stats }) => resolve(stats));
    });
}

/**
 * Creates socket manipulator that corrupts _parent socket byte properties.
 */
function createParentCorruptor(corruptionType) {
    const staticValues = {
        'undefined': undefined,
        'null': null,
        'string': '123',
    };

    return (socket) => {
        if (!socket._parent) return;

        if (corruptionType === 'invalid-getter') {
            // Create getters that return values less than TLS socket (invalid!)
            Object.defineProperty(socket._parent, 'bytesWritten', {
                get() { return Math.max(0, (socket.bytesWritten || 0) - 1000); },
                configurable: true,
            });
            Object.defineProperty(socket._parent, 'bytesRead', {
                get() { return Math.max(0, (socket.bytesRead || 0) - 1000); },
                configurable: true,
            });
        } else {
            // Set static invalid values
            Object.defineProperty(socket._parent, 'bytesWritten', {
                value: staticValues[corruptionType],
                writable: true,
                configurable: true,
            });
            Object.defineProperty(socket._parent, 'bytesRead', {
                value: staticValues[corruptionType],
                writable: true,
                configurable: true,
            });
        }
    };
}

/**
 * Expected stats for "Hello World" response (controlled payload, fixed certs, no session caching)
 * Exact values intentionally used for precise bug detection:
 * - Normal:   srcTxBytes = 2255 (with TLS overhead)
 * - Fallback: srcTxBytes = 174  (no TLS overhead)
 * - Broken:   srcTxBytes = 1200 (partial - ranges would miss this!)
 * If tests fail on Node.js upgrades, add tolerance then.
 */
const EXPECTED_HTTPS_STATS = { srcTxBytes: 2255, srcRxBytes: 528, trgTxBytes: 71, trgRxBytes: 174 };
const EXPECTED_HTTP_STATS = { srcTxBytes: 174, srcRxBytes: 93, trgTxBytes: 71, trgRxBytes: 174 };

const EXPECTED_FALLBACK_STATS = EXPECTED_HTTP_STATS;  // TLS overhead unavailable
const EXPECTED_NORMAL_STATS = EXPECTED_HTTPS_STATS;    // TLS overhead tracked

const EXPECTED_EVENT_PROPS = { reason: 'raw_socket_missing', hasParent: true, parentType: 'Socket' };

/**
 * Expected stats for chunked responses (controlled payloads with deterministic sizes)
 * Used in lifecycle and concurrent tests to validate exact byte counts
 */
const EXPECTED_CHUNKED_6KB_STATS = { srcTxBytes: 8226, srcRxBytes: 517, trgTxBytes: 60, trgRxBytes: 6123 };   // 2 chunks * 3KB
const EXPECTED_CHUNKED_20KB_STATS = { srcTxBytes: 22227, srcRxBytes: 517, trgTxBytes: 60, trgRxBytes: 20124 }; // 2 chunks * 10KB
const EXPECTED_CHUNKED_30KB_STATS = { srcTxBytes: 32249, srcRxBytes: 517, trgTxBytes: 60, trgRxBytes: 30124 }; // 3 chunks * 10KB

/**
 * Expected stats for TLS handshake-only (no HTTP request/response data)
 * - srcTxBytes: Server sends TLS handshake to client (ServerHello, Certificate, etc.)
 * - srcRxBytes: Server receives TLS handshake from client (ClientHello, etc.)
 * - trgTxBytes/trgRxBytes: null (no target connection established)
 */
const EXPECTED_TLS_HANDSHAKE_ONLY_STATS = { srcTxBytes: 1641, srcRxBytes: 337, trgTxBytes: null, trgRxBytes: null };

/**
 * Expected stats for keep-alive and separate connection tests (10 requests * 10KB each)
 * Keep-alive: Single connection reused for 10 requests (1 TLS handshake)
 * Separate: 10 separate connections (10 TLS handshakes)
 */
const EXPECTED_KEEPALIVE_10REQ_STATS = { srcTxBytes: 103799, srcRxBytes: 1503, trgTxBytes: 600, trgRxBytes: 101240 };
const EXPECTED_SEPARATE_10REQ_TOTAL = { srcTxBytes: 122050, srcRxBytes: 5170, trgTxBytes: 600, trgRxBytes: 101240 };

/**
 * Expected stats for SOCKS5 upstream scenarios - HTTPS proxy -> SOCKS5 -> HTTP target
 *
 * Source side (client<->proxy): Includes TLS overhead (handshake + encryption)
 * Target side (proxy<->SOCKS<->target): Application-layer + SOCKS protocol overhead
 *
 * SOCKS5 protocol overhead (measured from Docker tests):
 * - No auth: +2 bytes in trgTxBytes, +0 bytes in trgRxBytes (73 vs 71 base HTTP)
 * - With auth: +23 bytes in trgTxBytes, +2 bytes in trgRxBytes (94 vs 71 base HTTP)
 *   Auth adds username/password exchange overhead
 *
 * Values captured from Docker test run on Node.js 18.20.8
 */
const EXPECTED_SOCKS5_GET_NOAUTH_STATS = { srcTxBytes: 2252, srcRxBytes: 517, trgTxBytes: 73, trgRxBytes: 183 };
const EXPECTED_SOCKS5_CONNECT_NOAUTH_STATS = { srcTxBytes: 2313, srcRxBytes: 595, trgTxBytes: 73, trgRxBytes: 183 };
const EXPECTED_SOCKS5_GET_AUTH_STATS = { srcTxBytes: 2252, srcRxBytes: 517, trgTxBytes: 94, trgRxBytes: 185 };

/**
 * POST 100KB - HTTPS proxy -> HTTP target
 * Source side (client<->proxy): Includes TLS overhead (handshake + encryption)
 * Target side (proxy<->target): Application-layer only
 *
 * Request direction overhead: 103,112 - 102,523 = 589 bytes (~0.57%)
 * Response direction overhead: 104,808 - 102,566 = 2,242 bytes (~2.14%)
 * Total TLS overhead: 2,831 bytes for 204,800 bytes of payload (request + response)
 *
 * Values captured from Docker test run on Node.js 18.20.8
 */
const EXPECTED_POST_100KB_STATS = { srcTxBytes: 104808, srcRxBytes: 103112, trgTxBytes: 102523, trgRxBytes: 102566 };

/**
 * HEAD request - HTTPS proxy -> HTTP target
 * Source side (client<->proxy): Includes TLS overhead (handshake + encryption)
 * Target side (proxy<->target): Application-layer only (minimal headers, no body)
 *
 * Request direction overhead: 548 - 91 = 457 bytes (~83.4%)
 * Response direction overhead: 2,205 - 124 = 2,081 bytes (~94.4%)
 * TLS overhead dominates when response body is empty (HEAD request characteristic)
 *
 * Values captured from Docker test run on Node.js 18.20.8
 */
const EXPECTED_HEAD_STATS = { srcTxBytes: 2205, srcRxBytes: 548, trgTxBytes: 91, trgRxBytes: 124 };

/**
 * POST 204 No Content - HTTPS proxy -> HTTP target
 * Source side (client<->proxy): Includes TLS overhead (handshake + encryption)
 * Target side (proxy<->target): Application-layer only
 *
 * Asymmetric traffic pattern: Large request (50KB POST), zero response body (204 No Content)
 *
 * Request direction overhead: 51,848 - 51,325 = 523 bytes (~1.01%)
 * Response direction overhead: 2,187 - 106 = 2,081 bytes (~95.2%)
 * TLS overhead dominates in response direction when body is empty (similar to HEAD)
 *
 * Values captured from Docker test run on Node.js 18.20.8
 */
const EXPECTED_POST_204_STATS = { srcTxBytes: 2187, srcRxBytes: 51848, trgTxBytes: 51325, trgRxBytes: 106 };

describe('TLS Overhead Statistics', function() {
    this.timeout(30000);

    let freePorts;
    let targetServer;
    let httpProxyServer;
    let httpsProxyServer;

    before(async () => {
        freePorts = await portastic.find({ min: 50000, max: 50500 });

        const targetPort = freePorts.shift();
        targetServer = new TargetServer({
            port: targetPort,
            useSsl: false,
        });
        await targetServer.listen();

        const httpProxyPort = freePorts.shift();
        httpProxyServer = new Server({
            port: httpProxyPort,
            serverType: 'http',
            verbose: false,
        });
        await httpProxyServer.listen();

        const httpsProxyPort = freePorts.shift();
        httpsProxyServer = new Server({
            port: httpsProxyPort,
            serverType: 'https',
            httpsOptions: { key: sslKey, cert: sslCrt },
            verbose: false,
        });
        await httpsProxyServer.listen();
    });

    after(async () => {
        await wait(200); // Let all connections close

        if (httpProxyServer) {
            expect(httpProxyServer.getConnectionIds()).to.be.deep.equal([]);
            await httpProxyServer.close(true);
        }
        if (httpsProxyServer) {
            expect(httpsProxyServer.getConnectionIds()).to.be.deep.equal([]);
            await httpsProxyServer.close(true);
        }
        if (targetServer) {
            await targetServer.close();
        }
    });

    describe('Direct mechanism validation', () => {
        it('HTTPS proxy stats include TLS overhead (validated via exact byte counts)', async () => {
            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            const statsPromise = awaitConnectionStats(httpsProxyServer);
            const agent = createNonCachingAgent();

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${httpsProxyServer.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
                agent,
            });

            const httpsStats = await statsPromise;
            expect(httpsStats).to.not.be.null;
            expect(httpsStats).to.deep.include(EXPECTED_HTTPS_STATS);
        });

        it('HTTP proxy stats are application-layer only (no TLS overhead)', async () => {
            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            const statsPromise = awaitConnectionStats(httpProxyServer);

            await requestPromised({
                url: targetUrl,
                proxy: `http://127.0.0.1:${httpProxyServer.port}`,
            });

            const httpStats = await statsPromise;
            expect(httpStats).to.not.be.null;
            expect(httpStats).to.deep.include(EXPECTED_HTTP_STATS);
        });
    });

    // TODO: should be fixed after https://github.com/apify/proxy-chain/pull/607 (count TLS overhead bytes for HTTPS upstreams)
    it('target bytes should be similar for HTTP and HTTPS proxy (no TLS to target)', async () => {
        const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

        const httpStatsPromise = awaitConnectionStats(httpProxyServer);

        await requestPromised({
            url: targetUrl,
            proxy: `http://127.0.0.1:${httpProxyServer.port}`,
        });
        const httpStats = await httpStatsPromise;

        const httpsStatsPromise = awaitConnectionStats(httpsProxyServer);
        const agent = createNonCachingAgent();

        await requestPromised({
            url: targetUrl,
            proxy: `https://127.0.0.1:${httpsProxyServer.port}`,
            strictSSL: false,
            rejectUnauthorized: false,
            agent,
        });
        const httpsStats = await httpsStatsPromise;

        expect(httpStats).to.not.be.null;
        expect(httpsStats).to.not.be.null;

        // Target bytes should be application-layer only (no TLS overhead)
        // Both proxies connect to the same HTTP target (no TLS to target)
        expect(httpStats.trgTxBytes).to.not.be.null;
        expect(httpsStats.trgTxBytes).to.not.be.null;

        expect(httpStats.trgTxBytes).to.be.equal(httpsStats.trgTxBytes);
        expect(httpStats.trgRxBytes).to.be.equal(httpsStats.trgRxBytes);
    });

    describe('Handling connections with missing _parent socket property', () => {
        // API stability tests: simulate Node.js breaking socket._parent in future versions
        // If implementation stops using _parent, these tests can be removed

        let fallbackTestProxy;
        let socketManipulator;

        beforeEach(async () => {
            socketManipulator = null;

            // Create fresh proxy for each test to ensure test isolation and prevent state pollution
            const fallbackTestPort = freePorts.shift();
            fallbackTestProxy = new Server({
                port: fallbackTestPort,
                serverType: 'https',
                httpsOptions: { key: sslKey, cert: sslCrt },
                verbose: false,
            });
            await fallbackTestProxy.listen();
        });

        afterEach(async () => {
            if (fallbackTestProxy) {
                if (socketManipulator && fallbackTestProxy.server) {
                    fallbackTestProxy.server.removeListener('secureConnection', socketManipulator);
                }
                await fallbackTestProxy.close(true);
                fallbackTestProxy = null;
            }
            await wait(200); // Let connections fully close
        });

        // Helper function to install socket manipulator BEFORE connection processing
        const installSocketManipulator = (manipulator) => {
            socketManipulator = manipulator;
            // Use prependListener to ensure our manipulator runs BEFORE onConnection
            fallbackTestProxy.server.prependListener('secureConnection', socketManipulator);
        };

        it('handles missing _parent property (undefined)', async () => {
            // Scenario: socket._parent byte properties are undefined
            // Expected: Event fires, stats fallback to application-layer bytes

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            let unavailableEvent = null;
            fallbackTestProxy.once('tlsOverheadUnavailable', (data) => {
                unavailableEvent = data;
            });

            const statsPromise = awaitConnectionStats(fallbackTestProxy);

            installSocketManipulator(createParentCorruptor('undefined'));

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${fallbackTestProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            const stats = await statsPromise;
            expect(unavailableEvent).to.not.be.null;
            expect(unavailableEvent).to.deep.include(EXPECTED_EVENT_PROPS);
            expect(unavailableEvent.connectionId).to.be.a('number');

            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);
        });

        it('handles _parent byte properties set to null', async () => {
            // Scenario: socket._parent byte properties are explicitly null
            // Expected: Type check fails (typeof null !== 'number'), fallback occurs

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            let unavailableEvent = null;
            fallbackTestProxy.once('tlsOverheadUnavailable', (data) => {
                unavailableEvent = data;
            });

            const statsPromise = awaitConnectionStats(fallbackTestProxy);

            installSocketManipulator(createParentCorruptor('null'));

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${fallbackTestProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            const stats = await statsPromise;
            expect(unavailableEvent).to.not.be.null;
            expect(unavailableEvent).to.deep.include(EXPECTED_EVENT_PROPS);
            expect(unavailableEvent.connectionId).to.be.a('number');

            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);
        });

        it('handles _parent missing bytesWritten property', async () => {
            // Scenario: _parent exists but lacks bytesWritten property
            // Expected: Event fires with hasParent=true, fallback occurs

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            let unavailableEvent = null;
            fallbackTestProxy.once('tlsOverheadUnavailable', (data) => {
                unavailableEvent = data;
            });

            const statsPromise = new Promise((resolve) => {
                fallbackTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            installSocketManipulator(createParentCorruptor('undefined'));

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${fallbackTestProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            const stats = await statsPromise;
            expect(unavailableEvent).to.not.be.null;
            expect(unavailableEvent).to.deep.include(EXPECTED_EVENT_PROPS);
            expect(unavailableEvent.connectionId).to.be.a('number');

            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);
        });

        it('handles _parent missing bytesRead property', async () => {
            // Scenario: _parent exists but lacks bytesRead property
            // Expected: Similar to missing bytesWritten

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            let unavailableEvent = null;
            fallbackTestProxy.once('tlsOverheadUnavailable', (data) => {
                unavailableEvent = data;
            });

            const statsPromise = new Promise((resolve) => {
                fallbackTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            installSocketManipulator(createParentCorruptor('undefined'));

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${fallbackTestProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            const stats = await statsPromise;
            expect(unavailableEvent).to.not.be.null;
            expect(unavailableEvent).to.deep.include(EXPECTED_EVENT_PROPS);
            expect(unavailableEvent.connectionId).to.be.a('number');

            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);
        });

        it('handles _parent with invalid property types', async () => {
            // Scenario: _parent exists but properties are not numbers
            // Expected: Type check fails, fallback occurs

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            let unavailableEvent = null;
            fallbackTestProxy.once('tlsOverheadUnavailable', (data) => {
                unavailableEvent = data;
            });

            const statsPromise = new Promise((resolve) => {
                fallbackTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            installSocketManipulator(createParentCorruptor('string'));

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${fallbackTestProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            const stats = await statsPromise;
            expect(unavailableEvent).to.not.be.null;
            expect(unavailableEvent).to.deep.include(EXPECTED_EVENT_PROPS);
            expect(unavailableEvent.connectionId).to.be.a('number');

            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);
        });

        it('falls back to TLS socket bytes when raw socket reports fewer bytes than TLS socket', async () => {
            // Scenario: _parent exists with valid properties, but byte counts are inconsistent (raw < TLS)
            // Expected: Stats fallback to TLS socket bytes

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            // Capture connectionClosed event to access socket
            const statsPromise = new Promise((resolve) => {
                fallbackTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            installSocketManipulator(createParentCorruptor('invalid-getter'));

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${fallbackTestProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            const stats = await statsPromise;
            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);
        });

        it('logs warning when raw socket reports fewer bytes than TLS socket', async () => {
            // Scenario: _parent exists with valid properties, but byte counts are inconsistent (raw < TLS)
            // Expected: Warning logged for monitoring, stats fallback to TLS socket bytes

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            // Create a separate verbose server for log capture
            const verboseProxyPort = freePorts.shift();
            const verboseProxyServer = new Server({
                port: verboseProxyPort,
                serverType: 'https',
                httpsOptions: { key: sslKey, cert: sslCrt },
                verbose: true,  // CRITICAL: Enable logging for this test
            });
            await verboseProxyServer.listen();

            const consoleLogSpy = sinon.spy(console, 'log');

            const statsPromise = new Promise((resolve) => {
                verboseProxyServer.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            // Install socket manipulator on verbose server
            let manipulatorInstalled = false;
            const manipulator = (socket) => {
                if (!manipulatorInstalled && socket._parent) {
                    manipulatorInstalled = true;

                    // Override byte properties with getters that return invalid values
                    // This creates inconsistent byte counts: rawSocket.bytes < socket.bytes
                    Object.defineProperty(socket._parent, 'bytesWritten', {
                        get() {
                            // Return less than TLS socket bytes (invalid!)
                            return Math.max(0, (socket.bytesWritten || 0) - 1000);
                        },
                        configurable: true,
                    });
                    Object.defineProperty(socket._parent, 'bytesRead', {
                        get() {
                            // Return less than TLS socket bytes (invalid!)
                            return Math.max(0, (socket.bytesRead || 0) - 1000);
                        },
                        configurable: true,
                    });
                }
            };
            verboseProxyServer.server.prependListener('secureConnection', manipulator);

            try {
                await requestPromised({
                    url: targetUrl,
                    proxy: `https://127.0.0.1:${verboseProxyPort}`,
                    strictSSL: false,
                    rejectUnauthorized: false,
                });

                const stats = await statsPromise;
                expect(stats).to.not.be.null;
                expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);

                expect(consoleLogSpy.called).to.be.true;

                // Find the warning log in all console.log calls
                const logCalls = consoleLogSpy.getCalls();
                const warningLog = logCalls.find(call =>
                    call.args[0] && call.args[0].includes('Warning: TLS overhead count error')
                );

                expect(warningLog, 'Warning log should be emitted').to.exist;
                expect(warningLog.args[0]).to.be.a('string');
                expect(warningLog.args[0]).to.include('TLS overhead count error');
                expect(warningLog.args[0]).to.match(/ProxyServer.*TLS overhead count error/);
            } finally {
                // Cleanup: Restore spy and close verbose server
                consoleLogSpy.restore();
                verboseProxyServer.server.removeListener('secureConnection', manipulator);
                await verboseProxyServer.close(true);
            }
        });

        it('handles multiple connections with mixed _parent states', async () => {
            // Scenario: Some connections have valid _parent, others don't
            // Expected: Each connection handled independently, no cross-contamination

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            // Counter to alternate between valid and invalid _parent
            let connectionCount = 0;

            // Capture all events
            const unavailableEvents = [];
            const allStats = [];

            const eventListener = (data) => {
                unavailableEvents.push(data);
            };
            fallbackTestProxy.on('tlsOverheadUnavailable', eventListener);

            const statsListener = ({ stats }) => {
                allStats.push(stats);
            };
            fallbackTestProxy.on('connectionClosed', statsListener);

            // Install manipulator that alternates behavior
            const corruptorFn = createParentCorruptor('undefined');
            installSocketManipulator((socket) => {
                connectionCount++;
                const willCorrupt = connectionCount % 2 === 0;
                if (willCorrupt) {
                    corruptorFn(socket);
                }
                // Odd connections: Leave _parent intact (normal behavior)
            });

            // Make 4 requests (2 normal, 2 with invalid byte properties)
            // Important: Disable TLS session caching to ensure each connection performs
            // a full TLS handshake. Without this, Node.js will reuse sessions causing
            // connection #3 to show resumed session bytes (445) instead of full handshake (2255).
            for (let i = 0; i < 4; i++) {
                const agent = createNonCachingAgent();

                const closurePromise = new Promise((resolve) => {
                    fallbackTestProxy.once('connectionClosed', resolve);
                });

                await requestPromised({
                    url: targetUrl,
                    proxy: `https://127.0.0.1:${fallbackTestProxy.port}`,
                    strictSSL: false,
                    rejectUnauthorized: false,
                    agent,
                    headers: {
                        'Connection': 'close',
                    },
                });

                await closurePromise; // Wait for connection to close
            }

            expect(allStats.length).to.be.equal(4, 'Should have precisely 4 connections');

            expect(unavailableEvents.length).to.be.equal(2, 'Should have precisely 2 unavailable event');
            unavailableEvents.forEach((event) => {
                expect(event).to.deep.include(EXPECTED_EVENT_PROPS);
                expect(event.connectionId).to.be.a('number');
            });

            // Separate normal and fallback stats
            const normalStats = allStats.filter((s) => s.srcTxBytes > 1000); // Has TLS overhead
            const fallbackStats = allStats.filter((s) => s.srcTxBytes < 1000); // No TLS overhead

            // With session caching disabled, we should have exactly 2 normal and 2 fallback
            expect(normalStats.length).to.equal(2, 'Should have exactly 2 normal connections');
            expect(fallbackStats.length).to.equal(2, 'Should have exactly 2 fallback connections');

            // Cross-validation: events should match fallback stats
            expect(unavailableEvents.length).to.equal(fallbackStats.length, 'Unavailable events should match fallback connections (both should be 2)');

            normalStats.forEach((s) => {
                expect(s).to.deep.include(EXPECTED_NORMAL_STATS);
            });
            fallbackStats.forEach((s) => {
                expect(s).to.deep.include(EXPECTED_FALLBACK_STATS);
            });

            fallbackTestProxy.removeListener('tlsOverheadUnavailable', eventListener);
            fallbackTestProxy.removeListener('connectionClosed', statsListener);
        });
    });

    describe('Monitoring TLS overhead availability events', () => {
        // Public API observability tests: event timing, lifecycle, multi-connection monitoring

        let eventMonitoringProxy;
        let socketManipulator;

        beforeEach(async () => {
            socketManipulator = null;

            // Create fresh proxy for each test to ensure test isolation and prevent state pollution
            const eventMonitoringPort = freePorts.shift();
            eventMonitoringProxy = new Server({
                port: eventMonitoringPort,
                serverType: 'https',
                httpsOptions: { key: sslKey, cert: sslCrt },
                verbose: false,
            });
            await eventMonitoringProxy.listen();
        });

        afterEach(async () => {
            if (eventMonitoringProxy) {
                if (socketManipulator && eventMonitoringProxy.server) {
                    eventMonitoringProxy.server.removeListener('secureConnection', socketManipulator);
                }
                await eventMonitoringProxy.close(true);
                eventMonitoringProxy = null;
            }
            await wait(200); // Let connections fully close
        });

        // Helper function to install socket manipulator BEFORE connection processing
        const installSocketManipulator = (manipulator) => {
            socketManipulator = manipulator;
            // Use prependListener to ensure our manipulator runs BEFORE onConnection
            eventMonitoringProxy.server.prependListener('secureConnection', socketManipulator);
        };

        it('does not emit event when TLS overhead tracking is available (negative test)', async () => {
            // Scenario: Normal TLS overhead tracking with valid _parent socket
            // Expected: No tlsOverheadUnavailable event emission

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            let eventEmitted = false;
            let capturedEvent = null;
            const eventListener = (data) => {
                eventEmitted = true;
                capturedEvent = data;
            };
            eventMonitoringProxy.once('tlsOverheadUnavailable', eventListener);

            const statsPromise = new Promise((resolve) => {
                eventMonitoringProxy.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            // No socket manipulation - _parent should work normally
            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${eventMonitoringProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            const stats = await statsPromise;

            // Event should NOT have been emitted
            expect(eventEmitted).to.be.false;
            expect(capturedEvent).to.be.null;

            // Stats should show TLS overhead (normal operation)
            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_NORMAL_STATS);
        });

        it('emits event exactly once per connection (not on each stats query)', async () => {
            // Scenario: Connection with missing _parent, stats queried multiple times during lifecycle
            // Expected: Event emitted exactly once, not on each stats query

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            // Track event emissions
            let eventCount = 0;
            let capturedEvent = null;
            const eventListener = (data) => {
                eventCount++;
                capturedEvent = data;
            };
            eventMonitoringProxy.on('tlsOverheadUnavailable', eventListener);

            let connectionId = null;
            let statsQueryCount = 0;

            eventMonitoringProxy.once('tlsOverheadUnavailable', (data) => {
                connectionId = data.connectionId;
            });

            const statsPromise = new Promise((resolve) => {
                eventMonitoringProxy.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            installSocketManipulator(createParentCorruptor('undefined'));

            const requestPromise = requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${eventMonitoringProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            await wait(100);

            // Query stats multiple times if we have connectionId
            if (connectionId !== null) {
                for (let i = 0; i < 3; i++) {
                    eventMonitoringProxy.getConnectionStats(connectionId);
                    statsQueryCount++;
                    await wait(10);
                }
            }

            await requestPromise;
            const stats = await statsPromise;

            expect(eventCount).to.equal(1, 'Event should be emitted exactly once per connection');
            expect(capturedEvent).to.not.be.null;
            expect(capturedEvent).to.deep.include(EXPECTED_EVENT_PROPS);
            expect(capturedEvent.connectionId).to.be.a('number');

            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);

            eventMonitoringProxy.removeListener('tlsOverheadUnavailable', eventListener);
        });

        it('emits event during connection registration, not stats retrieval', async () => {
            // Scenario: Track timing of event emission vs first stats query
            // Expected: Event fires during connection registration, before any stats retrieval

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            // Track event and stats query timing
            let eventTimestamp = null;
            let firstStatsQueryTimestamp = null;
            let connectionId = null;

            const eventListener = (data) => {
                eventTimestamp = Date.now();
                connectionId = data.connectionId;
            };
            eventMonitoringProxy.once('tlsOverheadUnavailable', eventListener);

            const statsPromise = new Promise((resolve) => {
                eventMonitoringProxy.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            installSocketManipulator(createParentCorruptor('undefined'));

            const requestPromise = requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${eventMonitoringProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
            });

            await wait(100);

            // Now query stats (this should happen AFTER event was emitted)
            if (connectionId !== null) {
                firstStatsQueryTimestamp = Date.now();
                eventMonitoringProxy.getConnectionStats(connectionId);
            }

            await requestPromise;
            const stats = await statsPromise;

            // Event should fire before first stats query
            expect(eventTimestamp).to.not.be.null;
            expect(firstStatsQueryTimestamp).to.not.be.null;
            expect(eventTimestamp).to.be.lessThan(
                firstStatsQueryTimestamp,
                'Event should be emitted during connection registration, before stats queries'
            );

            expect(stats).to.not.be.null;
            expect(stats).to.deep.include(EXPECTED_FALLBACK_STATS);
        });

        it('supports monitoring events across multiple connections with mixed states', async () => {
            // Scenario: Multiple connections with alternating normal and fallback states
            // Expected: Events emitted only for fallback connections, stats tracked correctly for all

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            const allEvents = [];
            const allStats = [];

            const eventListener = (data) => {
                allEvents.push({ ...data, timestamp: Date.now() });
            };
            eventMonitoringProxy.on('tlsOverheadUnavailable', eventListener);

            const statsListener = ({ stats }) => {
                allStats.push(stats);
            };
            eventMonitoringProxy.on('connectionClosed', statsListener);

            // Counter to alternate between normal and fallback connections
            let connectionCount = 0;

            // Install manipulator that creates alternating pattern: 3 normal + 3 fallback
            const corruptorFn = createParentCorruptor('undefined');
            installSocketManipulator((socket) => {
                connectionCount++;
                // Pattern: odd = normal, even = fallback
                const shouldCorrupt = connectionCount % 2 === 0;
                if (shouldCorrupt) {
                    corruptorFn(socket);
                }
            });

            // Make 6 requests (3 normal, 3 fallback)
            for (let i = 0; i < 6; i++) {
                const agent = createNonCachingAgent();

                const closurePromise = new Promise((resolve) => {
                    eventMonitoringProxy.once('connectionClosed', resolve);
                });

                await requestPromised({
                    url: targetUrl,
                    proxy: `https://127.0.0.1:${eventMonitoringProxy.port}`,
                    strictSSL: false,
                    rejectUnauthorized: false,
                    agent,
                    headers: {
                        'Connection': 'close',
                    },
                });

                await closurePromise; // Wait for connection to close
            }

            // Should have exactly 3 events (one per fallback connection)
            expect(allStats.length).to.equal(6, 'Should have 6 total connections');
            expect(allEvents.length).to.equal(3, 'Should have exactly 3 events for 3 fallback connections');

            const eventConnectionIds = allEvents.map(e => e.connectionId);
            const uniqueConnectionIds = [...new Set(eventConnectionIds)];
            expect(uniqueConnectionIds).to.have.lengthOf(3, 'Each event should have unique connectionId');

            allEvents.forEach((event) => {
                expect(event).to.deep.include(EXPECTED_EVENT_PROPS);
                expect(event.connectionId).to.be.a('number');
            });

            // Separate normal and fallback stats
            const normalStats = allStats.filter(s => s.srcTxBytes > 1000);
            const fallbackStats = allStats.filter(s => s.srcTxBytes < 1000);

            expect(normalStats.length).to.equal(3, 'Should have 3 normal connections');
            expect(fallbackStats.length).to.equal(3, 'Should have 3 fallback connections');

            normalStats.forEach(s => {
                expect(s).to.deep.include(EXPECTED_NORMAL_STATS);
            });
            fallbackStats.forEach(s => {
                expect(s).to.deep.include(EXPECTED_FALLBACK_STATS);
            });

            expect(allEvents.length).to.equal(fallbackStats.length, 'Events should match fallback connections');

            eventMonitoringProxy.removeListener('tlsOverheadUnavailable', eventListener);
            eventMonitoringProxy.removeListener('connectionClosed', statsListener);
        });

        it('handles event listener lifecycle (add/remove/re-add)', async () => {
            // Scenario: Event listeners dynamically added, removed, and re-added during operation
            // Expected: Event listeners work correctly through the full lifecycle

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            // Track event captures
            let firstEventCaptured = false;
            let secondEventCaptured = false;
            let thirdEventCaptured = false;

            installSocketManipulator(createParentCorruptor('undefined'));

            // Add first listener and make request
            const firstListener = () => {
                firstEventCaptured = true;
            };
            eventMonitoringProxy.once('tlsOverheadUnavailable', firstListener);

            let closurePromise = new Promise((resolve) => {
                eventMonitoringProxy.once('connectionClosed', resolve);
            });

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${eventMonitoringProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
                agent: createNonCachingAgent(),
                headers: { 'Connection': 'close' },
            });
            await closurePromise;

            // Remove listener (implicitly removed by 'once') and make second request
            // The 'once' listener was already removed, so we explicitly test with no listener
            closurePromise = new Promise((resolve) => {
                eventMonitoringProxy.once('connectionClosed', resolve);
            });

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${eventMonitoringProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
                agent: createNonCachingAgent(),
                headers: { 'Connection': 'close' },
            });
            await closurePromise;

            // Re-add listener and make third request
            const thirdListener = () => {
                thirdEventCaptured = true;
            };
            eventMonitoringProxy.once('tlsOverheadUnavailable', thirdListener);

            closurePromise = new Promise((resolve) => {
                eventMonitoringProxy.once('connectionClosed', resolve);
            });

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${eventMonitoringProxy.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
                agent: createNonCachingAgent(),
                headers: { 'Connection': 'close' },
            });
            await closurePromise;

            // Listener lifecycle worked correctly
            expect(firstEventCaptured).to.be.true;
            expect(secondEventCaptured).to.be.false; // No listener was active
            expect(thirdEventCaptured).to.be.true;
        });
    });

    describe('Tracking statistics for failed TLS handshakes', () => {
        // This test suite validates that failed TLS handshakes are properly excluded from
        // connection statistics. Failed handshakes never reach secureConnection event,
        // so they never get registered in the connections Map.
        //
        // NOTE: tlsError event emission is platform-dependent (Node.js version, TLS implementation)
        // and is NOT tested here. Only core behavior (connection tracking) is validated.

        const tls = require('tls');

        let tlsHandshakeTestProxy;

        // Helper function to test TLS handshake with configurable parameters
        const testTLSHandshake = async ({
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

                socket.on('secureConnect', async () => {
                    const protocol = socket.getProtocol();
                    const cipher = socket.getCipher();

                    // Wait a bit before destroying to let connection registration complete
                    await new Promise(r => setTimeout(r, 50));

                    socket.destroy();
                    resolve({
                        success: true,
                        protocol,
                        cipher,
                    });
                });

                socket.on('error', (error) => {
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
                    socket.destroy();
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

        beforeEach(async () => {
            // Create a fresh HTTPS proxy server for each test
            const tlsHandshakeTestPort = freePorts.shift();
            tlsHandshakeTestProxy = new Server({
                port: tlsHandshakeTestPort,
                serverType: 'https',
                httpsOptions: { key: sslKey, cert: sslCrt },
                verbose: false,
            });
            await tlsHandshakeTestProxy.listen();
        });

        afterEach(async () => {
            if (tlsHandshakeTestProxy) {
                await tlsHandshakeTestProxy.close(true);
                tlsHandshakeTestProxy = null;
            }
            await wait(200); // Let connections fully close
        });

        it('does not track failed TLS handshakes in connection stats', async () => {
            // Scenario: TLS handshake fails before secureConnection event
            // Expected: No connectionId assigned, no connectionClosed event, connection not tracked

            // Track connectionClosed event (should NOT fire)
            let connectionClosedEmitted = false;
            tlsHandshakeTestProxy.once('connectionClosed', () => {
                connectionClosedEmitted = true;
            });

            const initialConnections = tlsHandshakeTestProxy.getConnectionIds();
            expect(initialConnections).to.have.lengthOf(0);

            // Attempt failed handshake (certificate validation)
            const result = await testTLSHandshake({
                host: '127.0.0.1',
                port: tlsHandshakeTestProxy.port,
                minVersion: 'TLSv1.2',
                maxVersion: 'TLSv1.3',
                rejectUnauthorized: true,  // Will reject self-signed cert
            });

            // Give a small buffer for any delayed events
            await wait(100);

            expect(result.success).to.be.false;
            expect(connectionClosedEmitted).to.be.false;

            const finalConnections = tlsHandshakeTestProxy.getConnectionIds();
            expect(finalConnections).to.have.lengthOf(0);
        });

        it('tracks successful TLS handshakes in connection stats (contrast with failures)', async () => {
            // Scenario: Successful TLS handshake with compatible protocol version
            // Expected: Connection tracked with stats, connectionClosed event emitted

            const statsPromise = new Promise((resolve) => {
                tlsHandshakeTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
            });

            // Attempt SUCCESSFUL handshake (TLS 1.2 - compatible with server)
            const result = await testTLSHandshake({
                host: '127.0.0.1',
                port: tlsHandshakeTestProxy.port,
                minVersion: 'TLSv1.2',
                maxVersion: 'TLSv1.2',
                rejectUnauthorized: false,
            });

            const connectionClosedStats = await statsPromise;

            expect(result.success).to.be.true;
            expect(result.protocol).to.equal('TLSv1.2');

            // Verify connectionClosed WAS emitted with stats
            expect(connectionClosedStats).to.not.be.null;
            expect(connectionClosedStats).to.deep.include(EXPECTED_TLS_HANDSHAKE_ONLY_STATS);
        });

        it('handles multiple failed handshakes without polluting connection tracking', async () => {
            // Scenario: Multiple failed handshakes in sequence
            // Expected: No connections tracked, no connectionClosed events, each failure handled independently

            const closedConnections = [];
            tlsHandshakeTestProxy.on('connectionClosed', (data) => {
                closedConnections.push(data);
            });

            // Attempt 5 failed handshakes (certificate validation)
            for (let i = 0; i < 5; i++) {
                await testTLSHandshake({
                    host: '127.0.0.1',
                    port: tlsHandshakeTestProxy.port,
                    minVersion: 'TLSv1.2',
                    maxVersion: 'TLSv1.3',
                    rejectUnauthorized: true,  // Will reject self-signed cert
                });
            }

            await wait(100); // Small buffer for any delayed processing

            expect(closedConnections).to.have.lengthOf(0);
            expect(tlsHandshakeTestProxy.getConnectionIds()).to.have.lengthOf(0);

            tlsHandshakeTestProxy.removeAllListeners('connectionClosed');
        });

        it('correctly isolates failed and successful handshakes', async () => {
            // Scenario: Mixed sequence of successful and failed handshakes
            // Expected: Only successful connections tracked with stats, failures properly isolated

            const closedConnections = [];
            tlsHandshakeTestProxy.on('connectionClosed', (data) => closedConnections.push(data));

            // Pattern: fail, succeed, fail, succeed, fail
            // Failures use certificate validation, successes accept cert
            const scenarios = [
                { rejectCert: true, shouldFail: true },
                { rejectCert: false, shouldFail: false },
                { rejectCert: true, shouldFail: true },
                { rejectCert: false, shouldFail: false },
                { rejectCert: true, shouldFail: true },
            ];

            for (const { rejectCert, shouldFail } of scenarios) {
                const closurePromise = shouldFail ? null : new Promise((resolve) => {
                    tlsHandshakeTestProxy.once('connectionClosed', resolve);
                });

                const result = await testTLSHandshake({
                    host: '127.0.0.1',
                    port: tlsHandshakeTestProxy.port,
                    minVersion: 'TLSv1.2',
                    maxVersion: 'TLSv1.3',
                    rejectUnauthorized: rejectCert,  // Fail when rejecting self-signed cert
                });

                expect(result.success).to.equal(!shouldFail);

                if (closurePromise) {
                    await closurePromise; // Wait for successful connection to close
                } else {
                    await wait(100); // Small buffer for failed connection
                }
            }

            expect(closedConnections).to.have.lengthOf(2);

            const connectionIds = closedConnections.map(c => c.connectionId);
            const uniqueIds = [...new Set(connectionIds)];
            expect(uniqueIds).to.have.lengthOf(2);

            // Note: Byte counts vary based on TLS version (1.2 vs 1.3) and session resumption
            closedConnections.forEach((conn) => {
                expect(conn.stats).to.exist;
                expect(conn.stats.srcTxBytes).to.be.a('number').greaterThan(1000).lessThan(3000);
                expect(conn.stats.srcRxBytes).to.be.a('number').greaterThan(200).lessThan(500);
                expect(conn.stats.trgTxBytes).to.be.null;
                expect(conn.stats.trgRxBytes).to.be.null;
            });

            tlsHandshakeTestProxy.removeAllListeners('connectionClosed');
        });
    });

    describe('Monitoring connection lifecycle and statistics evolution', () => {
        let lifecycleTestProxy;

        beforeEach(async () => {
            lifecycleTestProxy = new Server({
                port: freePorts.shift(),
                serverType: 'https',
                httpsOptions: { key: sslKey, cert: sslCrt },
                verbose: false,
            });
            await lifecycleTestProxy.listen();
        });

        afterEach(async () => {
            if (lifecycleTestProxy) {
                await lifecycleTestProxy.close(true);
            }
            await wait(200);
        });

        it('stats increase monotonically throughout connection lifecycle', async function() {
            // Increase timeout for this test (chunked response with delays)
            this.timeout(12000);

            // Create chunked target server with 2 chunks
            const chunk1 = 'A'.repeat(10000);
            const chunk2 = 'B'.repeat(10000);

            const chunkedPort = freePorts.shift();
            const chunkedServer = new ChunkedTargetServer({
                port: chunkedPort,
                chunks: [chunk1, chunk2],
                delayBetweenChunks: 1500,
            });

            await chunkedServer.listen();

            try {
                const targetUrl = `http://127.0.0.1:${chunkedPort}/`;

                let connectionId = null;
                let closedStats = null;
                const snapshots = [];

                lifecycleTestProxy.once('connectionClosed', ({ stats }) => {
                    closedStats = stats;
                });

                const agent = createNonCachingAgent();

                const requestPromise = requestPromised({
                    url: targetUrl,
                    proxy: `https://127.0.0.1:${lifecycleTestProxy.port}`,
                    agent,
                });

                // Wait for TLS handshake to complete and connection to be registered
                await wait(400);

                const connectionIds = lifecycleTestProxy.getConnectionIds();
                expect(connectionIds).to.have.lengthOf(1);
                connectionId = connectionIds[0];

                // Snapshot 1: Early in connection (after handshake, early in or before transfer)
                const snapshot1 = captureStatsSnapshot(lifecycleTestProxy, connectionId, 'early_in_connection');
                expect(snapshot1).to.not.be.null;
                snapshots.push(snapshot1);

                // Wait longer to ensure some data has been transferred
                await wait(2000); // Wait for chunk 1 + delay + start of chunk 2

                // Snapshot 2: Mid-connection (during transfer, if connection still active)
                const snapshot2 = captureStatsSnapshot(lifecycleTestProxy, connectionId, 'mid_connection');

                if (snapshot2 !== null) {
                    snapshots.push(snapshot2);
                }

                // Wait for request to complete
                await requestPromise;

                // Wait for connectionClosed event
                await wait(500);

                // Snapshot 3: From connectionClosed event (final)
                expect(closedStats).to.exist;
                snapshots.push({
                    label: 'connection_closed',
                    timestamp: Date.now(),
                    srcTxBytes: closedStats.srcTxBytes,
                    srcRxBytes: closedStats.srcRxBytes,
                    trgTxBytes: closedStats.trgTxBytes,
                    trgRxBytes: closedStats.trgRxBytes,
                });

                // Validate monotonic increase across all captured snapshots
                for (let i = 1; i < snapshots.length; i++) {
                    const prev = snapshots[i - 1];
                    const curr = snapshots[i];

                    expect(curr.srcTxBytes, `srcTxBytes decreased from ${prev.label} to ${curr.label}`)
                        .to.be.at.least(prev.srcTxBytes);
                    expect(curr.srcRxBytes, `srcRxBytes decreased from ${prev.label} to ${curr.label}`)
                        .to.be.at.least(prev.srcRxBytes);

                    // Target bytes should also be monotonic (if not null)
                    if (curr.trgTxBytes !== null && prev.trgTxBytes !== null) {
                        expect(curr.trgTxBytes, `trgTxBytes decreased from ${prev.label} to ${curr.label}`)
                            .to.be.at.least(prev.trgTxBytes);
                    }
                    if (curr.trgRxBytes !== null && prev.trgRxBytes !== null) {
                        expect(curr.trgRxBytes, `trgRxBytes decreased from ${prev.label} to ${curr.label}`)
                            .to.be.at.least(prev.trgRxBytes);
                    }
                }

                const firstSnapshot = snapshots[0];
                const lastSnapshot = snapshots[snapshots.length - 1];

                expect(closedStats).to.deep.include(EXPECTED_CHUNKED_20KB_STATS);

                const totalTxIncrease = lastSnapshot.srcTxBytes - firstSnapshot.srcTxBytes;
                expect(totalTxIncrease).to.be.greaterThan(5000); // At least 5KB transferred

                const rxVariance = Math.abs(lastSnapshot.srcRxBytes - firstSnapshot.srcRxBytes);
                expect(rxVariance).to.be.lessThan(500); // RX should stay relatively stable
            } finally {
                await chunkedServer.close();
                freePorts.push(chunkedPort);
            }
        });

        it('getConnectionStats() returns undefined after connection closes', async () => {
            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            const closurePromise = new Promise((resolve) => {
                lifecycleTestProxy.once('connectionClosed', ({ stats, connectionId }) => {
                    resolve({ stats, connectionId });
                });
            });

            const agent = createNonCachingAgent();

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${lifecycleTestProxy.port}`,
                agent,
            });

            const { stats: closedStats, connectionId } = await closurePromise;

            expect(connectionId).to.be.a('number');
            expect(closedStats).to.deep.include(EXPECTED_HTTPS_STATS);

            const statsAfterClose = lifecycleTestProxy.getConnectionStats(connectionId);
            expect(statsAfterClose).to.be.undefined;

            const activeConnectionIds = lifecycleTestProxy.getConnectionIds();
            expect(activeConnectionIds).to.be.an('array').that.is.empty;
        });

        it('getConnectionStats() matches connectionClosed event stats', async function() {
            this.timeout(8000);

            // Use chunked server with delay to keep connection open longer
            const chunk1 = 'X'.repeat(3000); // 3KB
            const chunk2 = 'Y'.repeat(3000); // 3KB
            const chunkedPort = freePorts.shift();
            const chunkedServer = new ChunkedTargetServer({
                port: chunkedPort,
                chunks: [chunk1, chunk2],
                delayBetweenChunks: 2000, // 2 second delay keeps connection open
            });

            await chunkedServer.listen();

            try {
                const targetUrl = `http://127.0.0.1:${chunkedPort}/`;

                let connectionId = null;
                let statsBeforeClose = null;

                const closurePromise = new Promise((resolve) => {
                    lifecycleTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
                });

                const agent = createNonCachingAgent();

                const requestPromise = requestPromised({
                    url: targetUrl,
                    proxy: `https://127.0.0.1:${lifecycleTestProxy.port}`,
                    agent,
                });

                await wait(500);

                const connectionIds = lifecycleTestProxy.getConnectionIds();
                expect(connectionIds).to.have.lengthOf(1);
                connectionId = connectionIds[0];

                statsBeforeClose = lifecycleTestProxy.getConnectionStats(connectionId);
                expect(statsBeforeClose).to.exist;

                await requestPromise;

                const closedStats = await closurePromise;

                expect(closedStats).to.exist;
                expect(closedStats).to.deep.include(EXPECTED_CHUNKED_6KB_STATS);

                // Stats before close should match or be close to connectionClosed event stats
                // Stats captured mid-transfer may be slightly less than final stats
                expect(closedStats.srcTxBytes).to.be.at.least(statsBeforeClose.srcTxBytes);
                expect(closedStats.srcRxBytes).to.be.at.least(statsBeforeClose.srcRxBytes);
                expect(closedStats.trgTxBytes).to.be.at.least(statsBeforeClose.trgTxBytes);
                expect(closedStats.trgRxBytes).to.be.at.least(statsBeforeClose.trgRxBytes);

                // Difference should be small (data in flight or final flush)
                const txDiff = closedStats.srcTxBytes - statsBeforeClose.srcTxBytes;
                const rxDiff = closedStats.srcRxBytes - statsBeforeClose.srcRxBytes;

                expect(txDiff).to.be.lessThan(10000); // Allow for in-flight data
                expect(rxDiff).to.be.lessThan(1000); // Request already sent
            } finally {
                await chunkedServer.close();
                freePorts.push(chunkedPort);
            }
        });

        it('stats accurately reflect known request/response sizes', async function() {
            // Increase timeout for this test (chunked response with delays)
            this.timeout(10000);

            // Create chunked target server with known response size
            // 3 chunks of 10KB each = 30KB total response
            const chunk1 = 'X'.repeat(10000);
            const chunk2 = 'Y'.repeat(10000);
            const chunk3 = 'Z'.repeat(10000);

            const chunkedPort = freePorts.shift();
            const chunkedServer = new ChunkedTargetServer({
                port: chunkedPort,
                chunks: [chunk1, chunk2, chunk3],
                delayBetweenChunks: 1000,
            });

            await chunkedServer.listen();

            try {
                const targetUrl = `http://127.0.0.1:${chunkedPort}/`;

                const closurePromise = new Promise((resolve) => {
                    lifecycleTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
                });

                const agent = createNonCachingAgent();

                const { body } = await requestPromised({
                    url: targetUrl,
                    proxy: `https://127.0.0.1:${lifecycleTestProxy.port}`,
                    agent,
                });

                expect(body).to.equal(chunk1 + chunk2 + chunk3);

                const closedStats = await closurePromise;

                expect(closedStats).to.exist;
                expect(closedStats).to.deep.include(EXPECTED_CHUNKED_30KB_STATS);

                // Stats accurately reflect known sizes:
                // - Target: 30KB (30000 bytes) + 124 bytes headers = 30124 bytes
                // - Source: 30124 bytes + TLS overhead (handshake ~2.5KB + encryption ~2KB) = 32249 bytes
                // - TLS overhead percentage: (32249 - 30124) / 30124 = ~7% (typical for large responses)
            } finally {
                await chunkedServer.close();
                freePorts.push(chunkedPort);
            }
        });

        it('handles concurrent getConnectionStats() calls accessing _parent safely', async function() {
            // Increase timeout for this test (chunked response with delays)
            this.timeout(10000);

            // Create chunked target server with delays to keep connection alive
            const chunk1 = Buffer.alloc(10000);
            const chunk2 = Buffer.alloc(10000);

            const chunkedPort = freePorts.shift();
            const chunkedServer = new ChunkedTargetServer({
                port: chunkedPort,
                chunks: [chunk1, chunk2],
                delayBetweenChunks: 2000,
            });

            await chunkedServer.listen();

            try {
                const targetUrl = `http://127.0.0.1:${chunkedPort}/`;

                let connectionId = null;

                // Capture final stats when connection closes
                const closurePromise = new Promise((resolve) => {
                    lifecycleTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
                });

                // Start request (don't await - let it run in background)
                const agent = createNonCachingAgent();

                const requestPromise = requestPromised({
                    url: targetUrl,
                    proxy: `https://127.0.0.1:${lifecycleTestProxy.port}`,
                    agent,
                });

                await wait(500);

                const connectionIds = lifecycleTestProxy.getConnectionIds();
                expect(connectionIds).to.have.lengthOf(1);
                connectionId = connectionIds[0];

                // Query stats 100 times concurrently
                const statQueries = Array.from({ length: 100 }, () =>
                    lifecycleTestProxy.getConnectionStats(connectionId)
                );

                const results = await Promise.all(statQueries);

                // All queries successful (no undefined)
                results.forEach((stats, i) => {
                    expect(stats, `Query ${i}`).to.not.be.undefined;
                    expect(stats).to.be.an('object');
                });

                // Validate exact values for stable metrics and ranges for in-progress metrics
                results.forEach((stats, i) => {
                    // Source RX: Request fully sent to proxy (stable)
                    expect(stats.srcRxBytes, `Query ${i} srcRxBytes`)
                        .to.equal(517);  // Exact value - request complete

                    // Target TX: Request fully forwarded to target (stable)
                    expect(stats.trgTxBytes, `Query ${i} trgTxBytes`)
                        .to.equal(60);   // Exact value - request forwarded

                    // Source TX: Handshake complete, partial response in progress
                    expect(stats.srcTxBytes, `Query ${i} srcTxBytes`)
                        .to.be.a('number')
                        .greaterThan(2000)   // At least TLS handshake (~2.5KB) + request
                        .lessThan(15000);    // Less than full response (22227)

                    // Target RX: First chunk in progress (0 to 10KB)
                    expect(stats.trgRxBytes, `Query ${i} trgRxBytes`)
                        .to.be.a('number')
                        .greaterThan(-1)     // Can be 0 if target hasn't started sending
                        .lessThan(11000);    // Less than first full chunk (10KB) + headers
                });

                // Values are consistent across all queries
                // All srcTxBytes values should be very similar (within 1KB variance)
                const txValues = results.map(s => s.srcTxBytes);
                const rxValues = results.map(s => s.srcRxBytes);

                const minTx = Math.min(...txValues);
                const maxTx = Math.max(...txValues);
                const minRx = Math.min(...rxValues);
                const maxRx = Math.max(...rxValues);

                // Within 1KB variance is acceptable (data might be in-flight)
                expect(maxTx - minTx, 'TX variance should be < 1KB').to.be.lessThan(1000);
                expect(maxRx - minRx, 'RX variance should be < 1KB').to.be.lessThan(1000);

                await requestPromise;

                const closedStats = await closurePromise;

                expect(closedStats).to.exist;
                expect(closedStats).to.deep.include(EXPECTED_CHUNKED_20KB_STATS);

                freePorts.push(chunkedPort);
            } finally {
                await chunkedServer.close();
            }
        });
    });

    describe('Multiple Requests and TLS Overhead Amortization', () => {
        // Validates TLS overhead behavior across keep-alive vs separate connections
        // Critical for production billing accuracy

        let keepAliveTestProxy;

        beforeEach(async () => {
            const testPort = freePorts.shift();
            keepAliveTestProxy = new Server({
                port: testPort,
                serverType: 'https',
                httpsOptions: { key: sslKey, cert: sslCrt },
                verbose: false,
            });
            await keepAliveTestProxy.listen();
        });

        afterEach(async () => {
            if (keepAliveTestProxy) {
                await keepAliveTestProxy.close(true);
            }
            await wait(200); // Let connections fully close
        });

        it('keep-alive connection amortizes TLS handshake overhead across multiple requests', async function() {
            // Scenario: 10 requests over a single keep-alive connection
            // Expected: ONE TLS handshake (~2.5KB) + 100KB data + ~5% encryption overhead
            // Total: ~107KB (handshake cost amortized across all requests)

            this.timeout(15000); // 10 requests with processing time

            // Create chunked server with 10KB responses
            const chunk1 = 'A'.repeat(10000);
            const chunkedPort = freePorts.shift();
            const chunkedServer = new ChunkedTargetServer({
                port: chunkedPort,
                chunks: [chunk1],
                delayBetweenChunks: 0,
            });
            await chunkedServer.listen();

            try {
                const targetUrl = `http://127.0.0.1:${chunkedPort}/`;

                const statsPromise = new Promise((resolve) => {
                    keepAliveTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
                });

                // Create agent with keep-alive enabled
                const agent = createNonCachingAgent({
                    keepAlive: true,      // Enable keep-alive (connection reuse)
                    maxSockets: 1,        // Limit to 1 socket to ensure reuse
                });

                // Make 10 requests over SAME connection
                for (let i = 0; i < 10; i++) {
                    await requestPromised({
                        url: targetUrl,
                        proxy: `https://127.0.0.1:${keepAliveTestProxy.port}`,
                        agent,  // Reuse same agent
                        strictSSL: false,
                        rejectUnauthorized: false,
                        // NO Connection: close header - keep-alive is default
                    });
                }

                // Close agent to trigger connection closure
                agent.destroy();

                const keepAliveStats = await statsPromise;

                expect(keepAliveStats).to.deep.include(EXPECTED_KEEPALIVE_10REQ_STATS);

                // Calculate total TLS overhead (handshake + encryption on both paths)
                // Formula: (source bytes with TLS) - (target bytes without TLS)
                // = (srcTxBytes + srcRxBytes) - (trgTxBytes + trgRxBytes)
                // This measures complete TLS overhead including:
                // - TLS handshake (~3.5KB for TLS 1.3 with this request size)
                // - Encryption overhead on requests (~18% of total overhead)
                // - Encryption overhead on responses (~82% of total overhead)
                const totalOverhead = (keepAliveStats.srcTxBytes + keepAliveStats.srcRxBytes)
                                     - (keepAliveStats.trgTxBytes + keepAliveStats.trgRxBytes);

                // Expected overhead: (103799 + 1503) - (600 + 101240) = 3462 bytes
                const expectedOverhead = (EXPECTED_KEEPALIVE_10REQ_STATS.srcTxBytes + EXPECTED_KEEPALIVE_10REQ_STATS.srcRxBytes)
                                        - (EXPECTED_KEEPALIVE_10REQ_STATS.trgTxBytes + EXPECTED_KEEPALIVE_10REQ_STATS.trgRxBytes);

                expect(totalOverhead).to.equal(expectedOverhead);

                freePorts.push(chunkedPort);
            } finally {
                await chunkedServer.close();
            }
        });

        it('separate connections have higher TLS overhead than keep-alive', async function() {
            // Scenario: 10 requests over 10 separate connections (Connection: close)
            // Expected: 10 TLS handshakes (~25KB) + 100KB data + ~5% encryption overhead
            // Total: ~130KB (handshake cost NOT amortized)

            this.timeout(20000); // 10 separate connections take longer

            // Create chunked server with 10KB responses
            const chunk1 = 'B'.repeat(10000);
            const chunkedPort = freePorts.shift();
            const chunkedServer = new ChunkedTargetServer({
                port: chunkedPort,
                chunks: [chunk1],
                delayBetweenChunks: 0,
            });
            await chunkedServer.listen();

            try {
                const targetUrl = `http://127.0.0.1:${chunkedPort}/`;

                // Collect all stats from multiple connections
                const allStats = [];
                const statsListener = ({ stats }) => {
                    allStats.push(stats);
                };
                keepAliveTestProxy.on('connectionClosed', statsListener);

                // Make 10 requests, each with NEW connection
                for (let i = 0; i < 10; i++) {
                    // Create NEW agent for each request (prevents connection reuse)
                    const agent = createNonCachingAgent();

                    const closurePromise = new Promise((resolve) => {
                        keepAliveTestProxy.once('connectionClosed', resolve);
                    });

                    await requestPromised({
                        url: targetUrl,
                        proxy: `https://127.0.0.1:${keepAliveTestProxy.port}`,
                        agent,  // NEW agent per request
                        strictSSL: false,
                        rejectUnauthorized: false,
                        headers: {
                            'Connection': 'close', // Force connection closure
                        },
                    });

                    await closurePromise; // Wait for connection to close before next request
                }

                expect(allStats.length).to.equal(10, 'Should have exactly 10 connections');

                // Validate exact total byte counts across all 10 connections
                const totals = {
                    srcTxBytes: allStats.reduce((sum, s) => sum + s.srcTxBytes, 0),
                    srcRxBytes: allStats.reduce((sum, s) => sum + s.srcRxBytes, 0),
                    trgTxBytes: allStats.reduce((sum, s) => sum + s.trgTxBytes, 0),
                    trgRxBytes: allStats.reduce((sum, s) => sum + s.trgRxBytes, 0),
                };
                expect(totals).to.deep.include(EXPECTED_SEPARATE_10REQ_TOTAL);

                // Calculate total TLS overhead across all connections
                // Formula: (all source bytes with TLS) - (all target bytes without TLS)
                const totalOverhead = (totals.srcTxBytes + totals.srcRxBytes)
                                     - (totals.trgTxBytes + totals.trgRxBytes);

                // Expected overhead: (122050 + 5170) - (600 + 101240) = 25380 bytes
                const expectedOverhead = (EXPECTED_SEPARATE_10REQ_TOTAL.srcTxBytes + EXPECTED_SEPARATE_10REQ_TOTAL.srcRxBytes)
                                        - (EXPECTED_SEPARATE_10REQ_TOTAL.trgTxBytes + EXPECTED_SEPARATE_10REQ_TOTAL.trgRxBytes);
                expect(totalOverhead).to.equal(expectedOverhead);

                keepAliveTestProxy.removeListener('connectionClosed', statsListener);
                freePorts.push(chunkedPort);
            } finally {
                await chunkedServer.close();
            }
        });

        it('validates overhead ratio: separate connections have ~10x more handshake overhead', async function() {
            // Comparative test: Validates the KEY billing behavior
            // Keep-alive should have ~10 LESS handshake overhead than separate connections
            // This is critical for accurate bandwidth accounting in production

            this.timeout(25000); // Both scenarios run sequentially

            // Create chunked server with 10KB responses
            const chunk1 = 'C'.repeat(10000);
            const chunkedPort = freePorts.shift();
            const chunkedServer = new ChunkedTargetServer({
                port: chunkedPort,
                chunks: [chunk1],
                delayBetweenChunks: 0,
            });
            await chunkedServer.listen();

            try {
                const targetUrl = `http://127.0.0.1:${chunkedPort}/`;

                // Scenario A: Keep-alive (1 connection, 10 requests)
                const keepAliveStatsPromise = new Promise((resolve) => {
                    keepAliveTestProxy.once('connectionClosed', ({ stats }) => resolve(stats));
                });

                const keepAliveAgent = createNonCachingAgent({
                    keepAlive: true,
                    maxSockets: 1,
                });

                for (let i = 0; i < 10; i++) {
                    await requestPromised({
                        url: targetUrl,
                        proxy: `https://127.0.0.1:${keepAliveTestProxy.port}`,
                        agent: keepAliveAgent,
                        strictSSL: false,
                        rejectUnauthorized: false,
                    });
                }

                keepAliveAgent.destroy();
                const keepAliveStats = await keepAliveStatsPromise;

                // Scenario B: Separate connections (10 connections, 10 requests)
                const separateStats = [];
                const statsListener = ({ stats }) => {
                    separateStats.push(stats);
                };
                keepAliveTestProxy.on('connectionClosed', statsListener);

                for (let i = 0; i < 10; i++) {
                    const agent = createNonCachingAgent();

                    const closurePromise = new Promise((resolve) => {
                        keepAliveTestProxy.once('connectionClosed', resolve);
                    });

                    await requestPromised({
                        url: targetUrl,
                        proxy: `https://127.0.0.1:${keepAliveTestProxy.port}`,
                        agent,
                        strictSSL: false,
                        rejectUnauthorized: false,
                        headers: {
                            'Connection': 'close',
                        },
                    });

                    await closurePromise;
                }

                expect(separateStats.length).to.equal(10);

                // Validate both scenarios match expected values
                expect(keepAliveStats).to.deep.include(EXPECTED_KEEPALIVE_10REQ_STATS);

                const separateTotals = {
                    srcTxBytes: separateStats.reduce((sum, s) => sum + s.srcTxBytes, 0),
                    srcRxBytes: separateStats.reduce((sum, s) => sum + s.srcRxBytes, 0),
                    trgTxBytes: separateStats.reduce((sum, s) => sum + s.trgTxBytes, 0),
                    trgRxBytes: separateStats.reduce((sum, s) => sum + s.trgRxBytes, 0),
                };
                expect(separateTotals).to.deep.include(EXPECTED_SEPARATE_10REQ_TOTAL);

                // Calculate total TLS overhead for both scenarios
                // Keep-alive: (source bytes with TLS) - (target bytes without TLS)
                const keepAliveOverhead = (keepAliveStats.srcTxBytes + keepAliveStats.srcRxBytes)
                                         - (keepAliveStats.trgTxBytes + keepAliveStats.trgRxBytes);

                // Separate: sum across all 10 connections
                const separateOverhead = (separateTotals.srcTxBytes + separateTotals.srcRxBytes)
                                        - (separateTotals.trgTxBytes + separateTotals.trgRxBytes);

                // Expected values from constants
                // Keep-alive: (103799 + 1503) - (600 + 101240) = 3462 bytes
                // Separate: (122050 + 5170) - (600 + 101240) = 25380 bytes
                const expectedKeepAliveOverhead = (EXPECTED_KEEPALIVE_10REQ_STATS.srcTxBytes + EXPECTED_KEEPALIVE_10REQ_STATS.srcRxBytes)
                                                 - (EXPECTED_KEEPALIVE_10REQ_STATS.trgTxBytes + EXPECTED_KEEPALIVE_10REQ_STATS.trgRxBytes);
                const expectedSeparateOverhead = (EXPECTED_SEPARATE_10REQ_TOTAL.srcTxBytes + EXPECTED_SEPARATE_10REQ_TOTAL.srcRxBytes)
                                                - (EXPECTED_SEPARATE_10REQ_TOTAL.trgTxBytes + EXPECTED_SEPARATE_10REQ_TOTAL.trgRxBytes);

                // Validate exact overhead values
                expect(keepAliveOverhead).to.equal(expectedKeepAliveOverhead); // 3462 bytes
                expect(separateOverhead).to.equal(expectedSeparateOverhead); // 25380 bytes

                // Validate overhead ratio
                // Expected ratio: 25380 / 3462 = 7.33
                const overheadRatio = separateOverhead / keepAliveOverhead;
                const expectedRatio = expectedSeparateOverhead / expectedKeepAliveOverhead;
                expect(overheadRatio).to.equal(expectedRatio);

                keepAliveTestProxy.removeListener('connectionClosed', statsListener);
                freePorts.push(chunkedPort);
            } finally {
                await chunkedServer.close();
            }
        });

        it('tracks TLS overhead correctly for resumed sessions (TLS 1.3)', async function() {
            // Scenario: 3 sequential requests with session caching enabled
            // Expected:
            // - First request has full TLS 1.3 handshake overhead (~2255 bytes srcTxBytes)
            // - Second and third requests have resumed session overhead (~445 bytes srcTxBytes, ~80% reduction)
            // Testing 2 resumed sessions (not just 1) proves session resumption is repeatable and stable
            //
            // Note: TLS 1.3 tested explicitly. TLS 1.2 session resumption uses the same
            // _parent socket tracking mechanism and is implicitly validated. TLS 1.2
            // produces different exact byte counts (~2500-3000 full handshake, ~500-800 resumed)
            // but achieves similar overhead reduction (~70-80%). The implementation is protocol-agnostic.

            this.timeout(10000);

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            const allStats = [];
            const statsListener = ({ stats }) => {
                allStats.push(stats);
            };
            keepAliveTestProxy.on('connectionClosed', statsListener);

            // Create agent with session caching ENABLED and force TLS 1.3
            const agent = new https.Agent({
                maxCachedSessions: 1,  // Enable session caching (opposite of other tests!)
                minVersion: 'TLSv1.3', // Force TLS 1.3 for deterministic byte counts
                maxVersion: 'TLSv1.3',
            });

            // Request 1: Full handshake
            const closurePromise1 = new Promise((resolve) => {
                keepAliveTestProxy.once('connectionClosed', resolve);
            });

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${keepAliveTestProxy.port}`,
                agent,
                strictSSL: false,
                rejectUnauthorized: false,
                headers: { 'Connection': 'close' }, // Force connection closure to trigger stats
            });

            await closurePromise1;

            // Request 2: Resumed session (reuses TLS session from Request 1)
            const closurePromise2 = new Promise((resolve) => {
                keepAliveTestProxy.once('connectionClosed', resolve);
            });

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${keepAliveTestProxy.port}`,
                agent, // SAME agent = session cache hit
                strictSSL: false,
                rejectUnauthorized: false,
                headers: { 'Connection': 'close' },
            });

            await closurePromise2;

            // Request 3: Resumed session (reuses TLS session from Request 1)
            const closurePromise3 = new Promise((resolve) => {
                keepAliveTestProxy.once('connectionClosed', resolve);
            });

            await requestPromised({
                url: targetUrl,
                proxy: `https://127.0.0.1:${keepAliveTestProxy.port}`,
                agent, // SAME agent = session cache hit
                strictSSL: false,
                rejectUnauthorized: false,
                headers: { 'Connection': 'close' },
            });

            await closurePromise3;

            expect(allStats.length).to.equal(3);

            const [fullHandshakeStats, resumedSessionStats1, resumedSessionStats2] = allStats;

            // Full handshake: TLS 1.3 full handshake overhead
            expect(fullHandshakeStats.srcTxBytes).to.equal(2255);
            expect(fullHandshakeStats.srcRxBytes).to.equal(404);
            expect(fullHandshakeStats.trgTxBytes).to.equal(71);
            expect(fullHandshakeStats.trgRxBytes).to.equal(174);

            // Resumed session: TLS 1.3 session resumption (80.3% reduction in srcTxBytes)
            expect(resumedSessionStats1.srcTxBytes).to.equal(445);
            expect(resumedSessionStats1.srcRxBytes).to.equal(675);
            expect(resumedSessionStats1.trgTxBytes).to.equal(71);
            expect(resumedSessionStats1.trgRxBytes).to.equal(174);

            expect(resumedSessionStats2.srcTxBytes).to.equal(445);
            expect(resumedSessionStats2.srcRxBytes).to.equal(675);
            expect(resumedSessionStats2.trgTxBytes).to.equal(71);
            expect(resumedSessionStats2.trgRxBytes).to.equal(174);


            // Validate overhead reduction
            // TLS 1.3 session resumption reduces client -> proxy handshake bytes by ~80%
            // Note: srcRxBytes is higher for resumed session due to TLS 1.3 NewSessionTicket message
            const overheadReduction1 = (fullHandshakeStats.srcTxBytes - resumedSessionStats1.srcTxBytes) / fullHandshakeStats.srcTxBytes;
            expect(overheadReduction1).to.be.approximately(0.803, 0.01); // 80.3% reduction

            const overheadReduction2 = (fullHandshakeStats.srcTxBytes - resumedSessionStats2.srcTxBytes) / fullHandshakeStats.srcTxBytes;
            expect(overheadReduction2).to.be.approximately(0.803, 0.01); // 80.3% reduction

            keepAliveTestProxy.removeListener('connectionClosed', statsListener);
            agent.destroy();
        });
    });

    describe('HTTP Methods with Different Payload Sizes (POST, HEAD)', () => {
        // Validates TLS overhead consistency across different HTTP methods and payload sizes.
        // This gap prevents validation of TLS overhead behavior across different traffic patterns.

        it('POST request with 100KB body maintains proportional TLS overhead', async () => {
            // Validates:
            // 1. TLS overhead scales appropriately with large request bodies
            // 2. Request direction TLS overhead (srcRxBytes > trgTxBytes)
            // 3. Response direction TLS overhead (srcTxBytes > trgRxBytes)
            // 4. forward.ts handler correctly tracks large POST requests
            //
            // Traffic flow:
            // REQUEST:  Client ──[srcRxBytes]──> Proxy ──[trgTxBytes]──> Target
            // RESPONSE: Client <──[srcTxBytes]── Proxy <──[trgRxBytes]── Target

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/echo-payload`;
            const postBody = 'X'.repeat(100 * 1024);  // 100KB

            const statsPromise = awaitConnectionStats(httpsProxyServer);
            const agent = createNonCachingAgent();

            const { body } = await requestPromised({
                url: targetUrl,
                method: 'POST',
                body: postBody,
                headers: {
                    'Content-Type': 'text/plain',
                },
                proxy: `https://127.0.0.1:${httpsProxyServer.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
                agent,
            });

            const stats = await statsPromise;

            // Exact byte equality validates TLS overhead in both directions
            // srcTxBytes (104808) > trgRxBytes (102566) - Response direction overhead
            // srcRxBytes (103112) > trgTxBytes (102523) - Request direction overhead
            expect(stats).to.deep.include(EXPECTED_POST_100KB_STATS);

            // Validate response echoes request body correctly
            expect(body).to.equal(postBody);
        });

        it('HEAD request validates TLS handshake overhead dominates minimal response body', async () => {
            // Validates:
            // 1. TLS overhead dominates when response body is empty (HEAD request)
            // 2. trgRxBytes is minimal (headers only, no body)
            // 3. TLS handshake overhead (~2.5KB) is majority of srcTxBytes (94.4% overhead)
            // 4. forward.ts handler correctly processes HEAD requests
            //
            // Traffic flow:
            // REQUEST:  Client ──[srcRxBytes]──> Proxy ──[trgTxBytes]──> Target
            // RESPONSE: Client <──[srcTxBytes]── Proxy <──[trgRxBytes]── Target

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/hello-world`;

            const statsPromise = awaitConnectionStats(httpsProxyServer);
            const agent = createNonCachingAgent();

            const { body } = await requestPromised({
                url: targetUrl,
                method: 'HEAD',
                proxy: `https://127.0.0.1:${httpsProxyServer.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
                agent,
            });

            const stats = await statsPromise;

            // Exact byte equality validates TLS overhead dominates minimal response
            // srcTxBytes (2205) > trgRxBytes (124) - TLS overhead is 2081 bytes (94.4%)
            // trgRxBytes (124) < 500 - Response is headers only
            expect(stats).to.deep.include(EXPECTED_HEAD_STATS);

            // Validate HEAD response has no body (HTTP spec compliance)
            expect(!body || body.length === 0, 'HEAD response body should be empty').to.be.true;
        });

        it('POST 204 No Content validates asymmetric traffic pattern (large request, zero response body)', async () => {
            // Validates:
            // 1. TLS overhead tracking for asymmetric traffic (large request, minimal response)
            // 2. Request direction TLS overhead with large payload (srcRxBytes > trgTxBytes)
            // 3. Response direction TLS overhead dominates when body is empty (srcTxBytes > trgRxBytes)
            // 4. forward.ts handler correctly processes 204 No Content responses
            //
            // Traffic flow (asymmetric pattern):
            // REQUEST:  Client ──[srcRxBytes: 51,848]──> Proxy ──[trgTxBytes: 51,325]──> Target (50KB POST)
            // RESPONSE: Client <──[srcTxBytes: 2,187]── Proxy <──[trgRxBytes: 106]── Target (204 No Content, empty body)

            const targetUrl = `http://127.0.0.1:${targetServer.httpServer.address().port}/echo-no-content`;
            const postBody = 'X'.repeat(50 * 1024);  // 50KB

            const statsPromise = awaitConnectionStats(httpsProxyServer);
            const agent = createNonCachingAgent();

            const { response, body } = await requestPromised({
                url: targetUrl,
                method: 'POST',
                body: postBody,
                headers: {
                    'Content-Type': 'text/plain',
                },
                proxy: `https://127.0.0.1:${httpsProxyServer.port}`,
                strictSSL: false,
                rejectUnauthorized: false,
                agent,
            });

            const stats = await statsPromise;

            // Exact byte equality validates TLS overhead in asymmetric traffic
            // Response: srcTxBytes (2187) > trgRxBytes (106) - TLS overhead dominates (95.2%)
            // Request: srcRxBytes (51848) > trgTxBytes (51325) - Minimal TLS overhead (1.01%)
            // Asymmetric: trgTxBytes (51325) >> trgRxBytes (106) - Request 485x larger than response
            expect(stats).to.deep.include(EXPECTED_POST_204_STATS);

            // Validate 204 No Content response (HTTP spec compliance)
            expect(response.statusCode).to.equal(204);
            expect(!body || body.length === 0, '204 response body should be empty').to.be.true;
        });
    });
});

describe('WebSocket TLS Overhead Tracking', function () {
    this.timeout(30000);

    it('websocket connection through HTTP proxy without TLS overhead for single message', async () => {
        const [targetServerPort, httpProxyPort] = await portastic.find({ min: 49000, max: 50000, retrieve: 2 });

        const targetServer = new TargetServer({ port: targetServerPort, useSsl: false });
        await targetServer.listen();

        const httpProxyServer = new Server({
            port: httpProxyPort,
            serverType: 'http',
            verbose: false,
        });
        await httpProxyServer.listen();

        try {
            const statsPromise = awaitConnectionStats(httpProxyServer);

            // Manual CONNECT tunneling for accurate byte counting
            const response = await new Promise((resolve, reject) => {
                const targetHostPort = `127.0.0.1:${targetServerPort}`;

                const connectRequest = http.request({
                    host: '127.0.0.1',
                    port: httpProxyPort,
                    method: 'CONNECT',
                    path: targetHostPort,
                    headers: { 'Host': targetHostPort },
                });

                connectRequest.on('connect', (res, socket) => {
                    if (res.statusCode !== 200) {
                        socket.destroy();
                        reject(new Error(`CONNECT failed: ${res.statusCode}`));
                        return;
                    }

                    const ws = new WebSocket(`ws://${targetHostPort}`, {
                        createConnection: () => socket,
                    });

                    ws.on('error', (err) => {
                        ws.close();
                        reject(err);
                    });

                    ws.on('open', () => ws.send('hello world'));

                    ws.on('message', (data) => {
                        ws.close();
                        resolve(data.toString());
                    });
                });

                connectRequest.on('error', reject);
                connectRequest.end();
            });

            expect(response).to.equal('I received: hello world');

            const stats = await statsPromise;

            const EXPECTED_WS_STATS = {
                srcTxBytes: 195,
                srcRxBytes: 325,
                trgTxBytes: 247,
                trgRxBytes: 156,
            };

            expect(stats).to.deep.include(EXPECTED_WS_STATS);
        } finally {
            await targetServer.close();
            await httpProxyServer.close();
        }
    });

    it('websocket connection through HTTPS proxy tracks TLS overhead correctly for single message', async () => {
        const [targetServerPort, httpsProxyPort] = await portastic.find({ min: 49000, max: 50000, retrieve: 2 });

        const targetServer = new TargetServer({ port: targetServerPort, useSsl: false });
        await targetServer.listen();

        const httpsProxyServer = new Server({
            port: httpsProxyPort,
            serverType: 'https',
            httpsOptions: { key: sslKey, cert: sslCrt },
            verbose: false,
        });
        await httpsProxyServer.listen();

        try {
            const statsPromise = awaitConnectionStats(httpsProxyServer);

            // Manual CONNECT tunneling for accurate byte counting
            const response = await new Promise((resolve, reject) => {
                const targetHostPort = `127.0.0.1:${targetServerPort}`;

                const connectRequest = https.request({
                    host: '127.0.0.1',
                    port: httpsProxyPort,
                    method: 'CONNECT',
                    path: targetHostPort,
                    headers: { 'Host': targetHostPort },
                    rejectUnauthorized: false,
                });

                connectRequest.on('connect', (res, socket) => {
                    if (res.statusCode !== 200) {
                        socket.destroy();
                        reject(new Error(`CONNECT failed: ${res.statusCode}`));
                        return;
                    }

                    const ws = new WebSocket(`ws://${targetHostPort}`, {
                        createConnection: () => socket,
                    });

                    ws.on('error', (err) => {
                        ws.close();
                        reject(err);
                    });

                    ws.on('open', () => ws.send('hello world'));

                    ws.on('message', (data) => {
                        ws.close();
                        resolve(data.toString());
                    });
                });

                connectRequest.on('error', reject);
                connectRequest.end();
            });

            expect(response).to.equal('I received: hello world');

            const stats = await statsPromise;

            const EXPECTED_WS_STATS = {
                srcTxBytes: 2342,
                srcRxBytes: 850,
                trgTxBytes: 247,
                trgRxBytes: 156,
            };

            expect(stats).to.deep.include(EXPECTED_WS_STATS);
        } finally {
            await targetServer.close();
            await httpsProxyServer.close();
        }
    });

    it('websocket connection through HTTPS proxy tracks TLS overhead correctly for multiple message', async () => {
        const [targetServerPort, httpsProxyPort] = await portastic.find({ min: 49000, max: 50000, retrieve: 2 });

        const targetServer = new TargetServer({ port: targetServerPort, useSsl: false });
        await targetServer.listen();

        const httpsProxyServer = new Server({
            port: httpsProxyPort,
            serverType: 'https',
            httpsOptions: { key: sslKey, cert: sslCrt },
            verbose: false,
        });
        await httpsProxyServer.listen();

        try {
            let connectionId = null;
            const statsSnapshots = [];

            // Capture connection ID when connection opens
            httpsProxyServer.once('connectionClosed', ({ connectionId: id, stats }) => {
                connectionId = id;
                statsSnapshots.push({ label: 'final', ...stats });
            });

            // Create WebSocket connection and send multiple messages
            const targetHost = '127.0.0.1';
            const targetHostPort = `${targetHost}:${targetServerPort}`;
            const wsUrl = `ws://${targetHostPort}`;
            const proxyUrl = `https://127.0.0.1:${httpsProxyPort}`;
            const messagesToSend = 5;

            await new Promise((resolve, reject) => {
                const proxyParsed = new URL(proxyUrl);

                // Create CONNECT request to proxy
                const connectRequest = https.request({
                    host: proxyParsed.hostname,
                    port: proxyParsed.port,
                    method: 'CONNECT',
                    path: targetHostPort,
                    headers: { 'Host': targetHostPort },
                    rejectUnauthorized: false,
                });

                connectRequest.on('connect', (res, socket) => {
                    if (res.statusCode !== 200) {
                        socket.destroy();
                        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
                        return;
                    }

                    const ws = new WebSocket(wsUrl, {
                        createConnection: () => socket,
                    });

                    let messagesSent = 0;
                    let messagesReceived = 0;

                    ws.on('error', (err) => {
                        ws.close();
                        reject(err);
                    });

                    ws.on('open', () => {
                        // Send first message
                        ws.send(`message-${messagesSent++}`);
                    });

                    ws.on('message', (data) => {
                        messagesReceived++;
                        expect(data.toString()).to.match(/^I received: message-\d+$/);

                        if (messagesSent < messagesToSend) {
                            // Send next message
                            ws.send(`message-${messagesSent++}`);
                        } else if (messagesReceived === messagesToSend) {
                            // All messages sent and received
                            ws.close();
                            resolve();
                        }
                    });
                });

                connectRequest.on('error', reject);
                connectRequest.end();
            });

            // Wait for connection to close
            await wait(100);

            // Verify we captured stats
            expect(statsSnapshots.length).to.equal(1);
            const finalStats = statsSnapshots[0];

            const EXPECTED_MULTI_MSG_STATS = {
                srcTxBytes: 2520,
                srcRxBytes: 1267,
                trgTxBytes: 305,
                trgRxBytes: 246,
            };

            const { label, ...statsWithoutLabel } = finalStats;
            expect(statsWithoutLabel).to.deep.equal(EXPECTED_MULTI_MSG_STATS);
        } finally {
            await targetServer.close();
            await httpsProxyServer.close();
        }
    });
});

describe('TLS Overhead with SOCKS5 Upstream', function () {
    this.timeout(20000);

    it('GET request via SOCKS5 without authentication and without TLS overhead', async () => {
        const [socksPort, httpProxyPort, targetPort] = await portastic.find({ min: 51000, max: 51500, retrieve: 3 });

        const socksServer = socksv5.createServer((_, accept) => {
            accept();
        });

        await new Promise((resolve) => {
            socksServer.listen(socksPort, '127.0.0.1', () => {
                socksServer.useAuth(socksv5.auth.None());
                resolve();
            });
        });

        const targetServer = new TargetServer({ port: targetPort, useSsl: false });
        await targetServer.listen();

        // Setup HTTP proxy with SOCKS5 upstream (no auth)
        const httpProxyServer = new Server({
            port: httpProxyPort,
            serverType: 'http',
            prepareRequestFunction: () => ({
                upstreamProxyUrl: `socks5://127.0.0.1:${socksPort}`,
            }),
            verbose: false,
        });
        await httpProxyServer.listen();

        try {
            const statsPromise = awaitConnectionStats(httpProxyServer);

            const { response, body } = await requestPromised({
                url: `http://127.0.0.1:${targetPort}`,
                proxy: `http://127.0.0.1:${httpProxyPort}`,
            });

            expect(response.statusCode).to.equal(200);
            expect(body).to.equal('It works!');

            const stats = await statsPromise;

            // Validate HTTP proxy has no TLS overhead
            expect(stats).to.deep.include({ srcTxBytes: 171, srcRxBytes: 82, trgTxBytes: 73, trgRxBytes: 183 });
        } finally {
            await new Promise((resolve) => socksServer.close(resolve));
            await targetServer.close();
            await httpProxyServer.close();
        }
    });

    it('GET request via SOCKS5 without authentication tracks TLS overhead correctly', async () => {
        const [socksPort, httpsProxyPort, targetPort] = await portastic.find({ min: 51000, max: 51500, retrieve: 3 });

        const socksServer = socksv5.createServer((_, accept) => {
            accept();
        });

        await new Promise((resolve) => {
            socksServer.listen(socksPort, '127.0.0.1', () => {
                socksServer.useAuth(socksv5.auth.None());
                resolve();
            });
        });

        const targetServer = new TargetServer({ port: targetPort, useSsl: false });
        await targetServer.listen();

        // Setup HTTPS proxy with SOCKS5 upstream (no auth)
        const httpsProxyServer = new Server({
            port: httpsProxyPort,
            serverType: 'https',
            httpsOptions: {
                key: sslKey,
                cert: sslCrt,
                maxCachedSessions: 0,  // Critical for determinism
            },
            prepareRequestFunction: () => ({
                upstreamProxyUrl: `socks5://127.0.0.1:${socksPort}`,
            }),
            verbose: false,
        });
        await httpsProxyServer.listen();

        try {
            const statsPromise = awaitConnectionStats(httpsProxyServer);

            // Make GET request through HTTPS proxy (which routes via SOCKS5)
            const agent = createNonCachingAgent({ rejectUnauthorized: false });
            const { response, body } = await requestPromised({
                url: `http://127.0.0.1:${targetPort}`,
                proxy: `https://127.0.0.1:${httpsProxyPort}`,
                agent,
            });

            expect(response.statusCode).to.equal(200);
            expect(body).to.equal('It works!');

            const stats = await statsPromise;

            expect(stats).to.deep.include(EXPECTED_SOCKS5_GET_NOAUTH_STATS);

            agent.destroy();
        } finally {
            await new Promise((resolve) => socksServer.close(resolve));
            await targetServer.close();
            await httpsProxyServer.close();
        }
    });

    it('CONNECT request via SOCKS5 without authentication tracks TLS overhead correctly', async () => {
        const [socksPort, httpsProxyPort, targetPort] = await portastic.find({ min: 51000, max: 51500, retrieve: 3 });

        const socksServer = socksv5.createServer((_, accept) => {
            accept();
        });

        await new Promise((resolve) => {
            socksServer.listen(socksPort, '127.0.0.1', () => {
                socksServer.useAuth(socksv5.auth.None());
                resolve();
            });
        });

        const targetServer = new TargetServer({ port: targetPort, useSsl: false });
        await targetServer.listen();

        // Setup HTTPS proxy with SOCKS5 upstream (no auth)
        const httpsProxyServer = new Server({
            port: httpsProxyPort,
            serverType: 'https',
            httpsOptions: {
                key: sslKey,
                cert: sslCrt,
                maxCachedSessions: 0,  // Critical for determinism
            },
            prepareRequestFunction: () => ({
                upstreamProxyUrl: `socks5://127.0.0.1:${socksPort}`,
            }),
            verbose: false,
        });
        await httpsProxyServer.listen();

        try {
            const statsPromise = awaitConnectionStats(httpsProxyServer);

            // Manual CONNECT tunneling
            const response = await new Promise((resolve, reject) => {
                const targetHostPort = `127.0.0.1:${targetPort}`;

                const connectRequest = https.request({
                    host: '127.0.0.1',
                    port: httpsProxyPort,
                    method: 'CONNECT',
                    path: targetHostPort,
                    headers: { 'Host': targetHostPort },
                    rejectUnauthorized: false,
                });

                connectRequest.on('connect', (res, socket) => {
                    if (res.statusCode !== 200) {
                        socket.destroy();
                        reject(new Error(`CONNECT failed: ${res.statusCode}`));
                        return;
                    }

                    // Make HTTP request through the tunnel
                    const requestData = `GET / HTTP/1.1\r\nHost: ${targetHostPort}\r\nConnection: close\r\n\r\n`;
                    socket.write(requestData);

                    let responseData = '';
                    socket.on('data', (chunk) => {
                        responseData += chunk.toString();
                    });

                    socket.on('end', () => {
                        socket.destroy();
                        resolve(responseData);
                    });

                    socket.on('error', reject);
                });

                connectRequest.on('error', reject);
                connectRequest.end();
            });

            expect(response).to.contain('It works!');

            const stats = await statsPromise;

            expect(stats).to.deep.include(EXPECTED_SOCKS5_CONNECT_NOAUTH_STATS);
        } finally {
            await new Promise((resolve) => socksServer.close(resolve));
            await targetServer.close();
            await httpsProxyServer.close();
        }
    });

    it('GET request via SOCKS5 with authentication shows SOCKS overhead in target bytes', async () => {
        const [socksPort, httpsProxyPort, targetPort] = await portastic.find({ min: 51000, max: 51500, retrieve: 3 });

        const socksServer = socksv5.createServer((_, accept) => {
            accept();
        });

        await new Promise((resolve) => {
            socksServer.listen(socksPort, '127.0.0.1', () => {
                socksServer.useAuth(socksv5.auth.UserPassword((user, password, cb) => {
                    // Accept credentials: username 'proxy-ch@in', password 'rules!'
                    cb(user === 'proxy-ch@in' && password === 'rules!');
                }));
                resolve();
            });
        });

        const targetServer = new TargetServer({ port: targetPort, useSsl: false });
        await targetServer.listen();

        // Setup HTTPS proxy with SOCKS5 upstream (with auth)
        // Note: URL-encode '@' in username: proxy-ch@in -> proxy-ch%40in
        const httpsProxyServer = new Server({
            port: httpsProxyPort,
            serverType: 'https',
            httpsOptions: {
                key: sslKey,
                cert: sslCrt,
                maxCachedSessions: 0,  // Critical for determinism
            },
            prepareRequestFunction: () => ({
                upstreamProxyUrl: `socks5://proxy-ch%40in:rules!@127.0.0.1:${socksPort}`,
            }),
            verbose: false,
        });
        await httpsProxyServer.listen();

        try {
            const statsPromise = awaitConnectionStats(httpsProxyServer);

            // Make GET request through HTTPS proxy (which routes via SOCKS5 with auth)
            const agent = createNonCachingAgent({ rejectUnauthorized: false });
            const { response, body } = await requestPromised({
                url: `http://127.0.0.1:${targetPort}`,
                proxy: `https://127.0.0.1:${httpsProxyPort}`,
                agent,
            });

            expect(response.statusCode).to.equal(200);
            expect(body).to.equal('It works!');

            const stats = await statsPromise;

            // Note: SOCKS5 authentication adds ~21 bytes to target bytes vs no-auth test
            // This overhead is visible in trgTxBytes (94 vs 73) and trgRxBytes (185 vs 183)
            // Auth bytes: username/password exchange during SOCKS5 handshake

            expect(stats).to.deep.include(EXPECTED_SOCKS5_GET_AUTH_STATS);

            agent.destroy();
        } finally {
            await new Promise((resolve) => socksServer.close(resolve));
            await targetServer.close();
            await httpsProxyServer.close();
        }
    });
});

 // TODO: consider to add in future
 // 1. Upstream Combinations
 // - HTTPS proxy -> HTTPS upstream
 // 2. Very Large Transfers
 // - Transfer >100MB, validate byte counters don't overflow

