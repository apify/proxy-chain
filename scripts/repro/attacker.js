/* eslint-disable no-console */
/**
 * Attacker container: a different host on the same network, with no credentials of any kind.
 * Asks the victim which port its tunnel ended up on, then makes a single attempt at it.
 *
 * Exits 0 when the tunnel served the payload (exposed) and 3 when it refused the connection.
 */

import { probe, readFirstChunk, SECRET_PAYLOAD } from './fixtures.js';

const VICTIM_HOST = process.env.VICTIM_HOST ?? 'victim';
const READINESS_PORT = Number(process.env.READINESS_PORT ?? 8001);
const READINESS_ATTEMPTS = 60;

/** Resolves to the port the victim's tunnel is listening on, once the victim is up. */
const waitForTunnelPort = async () => {
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt++) {
        try {
            return Number(await readFirstChunk(VICTIM_HOST, READINESS_PORT, 1000));
        } catch {
            await new Promise((resolve) => { setTimeout(resolve, 500); });
        }
    }

    throw new Error(`${VICTIM_HOST}:${READINESS_PORT} never became ready`);
};

const tunnelPort = await waitForTunnelPort();
const result = await probe(VICTIM_HOST, tunnelPort);

if (!result.reachable) {
    console.log(`[attacker] ${VICTIM_HOST}:${tunnelPort} refused the connection (${result.reason})`);
    process.exit(3);
}

if (result.payload !== SECRET_PAYLOAD) {
    console.log(`[attacker] ${VICTIM_HOST}:${tunnelPort} accepted the connection but did not relay - received "${result.payload}"`);
    process.exit(4);
}

console.log(`[attacker] tunnelled through ${VICTIM_HOST}:${tunnelPort} with no credentials, received "${result.payload}"`);
