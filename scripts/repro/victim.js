/* eslint-disable no-console */
/**
 * Victim container: runs the upstream proxy and the target on loopback, then exposes a tunnel
 * to them. TUNNEL_HOSTNAME reproduces the pre-fix binding when set to 0.0.0.0; left empty,
 * createTunnel() picks its own default.
 *
 * The tunnel port is whatever createTunnel() picks - versions before the fix ignore the port
 * option - so it is announced on READINESS_PORT, which also tells the attacker when to start.
 */

import net from 'node:net';

import { createTunnel } from '../../src/index.js';
import { listen, parseEndpoint, startVictimServices } from './fixtures.js';

const READINESS_PORT = Number(process.env.READINESS_PORT ?? 8001);
const hostname = process.env.TUNNEL_HOSTNAME || undefined;

process.on('warning', (warning) => console.log(`[victim] ${warning.name}: ${warning.message}`));

const { proxyUrl, targetHost, authorizedConnects } = await startVictimServices();
const tunnel = await createTunnel(proxyUrl, targetHost, { hostname });
const { port: tunnelPort } = parseEndpoint(tunnel);

console.log(`[victim] tunnel listening on ${tunnel} (hostname option: ${hostname ?? 'default'})`);

await listen(net.createServer((socket) => socket.end(String(tunnelPort))), '0.0.0.0', READINESS_PORT);

console.log('[victim] ready');

process.on('SIGTERM', () => {
    console.log(`[victim] upstream credentials spent on ${authorizedConnects.length} client connection(s)`);
    process.exit(0);
});
