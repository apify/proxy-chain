/* eslint-disable no-console */
/**
 * Single-host variant of the GHSA-5vwf-g8jp-pgj3 reproduction, for when Docker is not available.
 *
 * It plays the attacker from the host's own non-loopback address instead of from another host,
 * so a host firewall can make it inconclusive. run.sh is the reliable version.
 *
 * Usage: node --import tsx scripts/repro/local.js
 */

import os from 'node:os';

import { closeTunnel, createTunnel } from '../../src/index.js';
import { parseEndpoint, probe, startVictimServices } from './fixtures.js';

const findNonLoopbackIpv4 = () => Object.values(os.networkInterfaces())
    .flat()
    .find((networkInterface) => networkInterface.family === 'IPv4' && !networkInterface.internal)
    ?.address;

const describeProbe = (result) => (result.reachable
    ? `tunnelled, received "${result.payload}"`
    : `refused (${result.reason})`);

const main = async () => {
    const attackerHost = findNonLoopbackIpv4();

    if (!attackerHost) {
        console.error('No non-loopback IPv4 address on this host - the exposure cannot be demonstrated here.');
        return 1;
    }

    process.on('warning', (warning) => console.log(`[warning] ${warning.name}: ${warning.message}`));

    const { proxyUrl, targetHost, authorizedConnects, close } = await startVictimServices();

    console.log(`upstream proxy   ${proxyUrl.replace(/:[^:@]*@/, ':***@')}`);
    console.log(`target           ${targetHost}`);
    console.log(`attacker source  ${attackerHost}\n`);

    let failures = 0;

    const exposedTunnel = await createTunnel(proxyUrl, targetHost, { hostname: '0.0.0.0' });
    const exposed = await probe(attackerHost, parseEndpoint(exposedTunnel).port);

    console.log(`pre-fix binding   tunnel at ${exposedTunnel}`);
    console.log(`  attacker -> ${describeProbe(exposed)}`);
    console.log(`  upstream credentials spent on ${authorizedConnects.length} unauthenticated client connection(s)\n`);

    if (!exposed.reachable) {
        console.error('  INCONCLUSIVE: the 0.0.0.0 binding was not reachable - is a host firewall blocking it?');
        failures += 1;
    }

    await closeTunnel(exposedTunnel, true);

    const defaultTunnel = await createTunnel(proxyUrl, targetHost);
    const { host: defaultHost, port: defaultPort } = parseEndpoint(defaultTunnel);
    const blocked = await probe(attackerHost, defaultPort);
    const owner = await probe(defaultHost, defaultPort);

    console.log(`current default   tunnel at ${defaultTunnel}`);
    console.log(`  attacker -> ${describeProbe(blocked)}`);
    console.log(`  owner    -> ${describeProbe(owner)}`);

    if (blocked.reachable) {
        console.error('  FAIL: the default binding is still reachable off loopback.');
        failures += 1;
    }

    if (!owner.reachable) {
        console.error('  FAIL: the default binding is not usable from loopback.');
        failures += 1;
    }

    await closeTunnel(defaultTunnel, true);
    await close();

    console.log(`\n${failures === 0 ? 'OK - reproduced against the pre-fix binding, refused by the default.' : `${failures} check(s) failed.`}`);

    return failures === 0 ? 0 : 1;
};

try {
    process.exitCode = await main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
