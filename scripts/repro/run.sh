#!/bin/bash
# Reproduction of GHSA-5vwf-g8jp-pgj3 across two containers.
#
# Scenario 1 reproduces the pre-fix binding and expects the attacker to get through.
# Scenario 2 uses the current default and expects it to be refused.

set -u

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPOSED_EXIT_CODE=0
REFUSED_EXIT_CODE=3

run_scenario() {
    local tunnel_hostname="$1"

    TUNNEL_HOSTNAME="${tunnel_hostname}" docker compose --file "${COMPOSE_DIR}/compose.yaml" \
        up --build --abort-on-container-exit --exit-code-from attacker
    local exit_code=$?

    docker compose --file "${COMPOSE_DIR}/compose.yaml" down --remove-orphans >/dev/null 2>&1

    return ${exit_code}
}

echo "=== 1/2: pre-fix binding (hostname: 0.0.0.0) - the attacker should get through ==="
run_scenario "0.0.0.0"
exposed=$?

echo
echo "=== 2/2: current default - the attacker should be refused ==="
run_scenario ""
blocked=$?

echo
echo "========== Results =========="
[ ${exposed} -eq ${EXPOSED_EXIT_CODE} ] \
    && echo "pre-fix binding:  REPRODUCED - unauthenticated peer tunnelled through" \
    || echo "pre-fix binding:  INCONCLUSIVE - the attacker did not get through (exit ${exposed})"
[ ${blocked} -eq ${REFUSED_EXIT_CODE} ] \
    && echo "current default:  FIXED - the attacker was refused" \
    || echo "current default:  FAIL - the tunnel is still reachable off loopback (exit ${blocked})"
echo "============================="

[ ${exposed} -eq ${EXPOSED_EXIT_CODE} ] && [ ${blocked} -eq ${REFUSED_EXIT_CODE} ]
