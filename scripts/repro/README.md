# GHSA-5vwf-g8jp-pgj3 reproduction

`createTunnel()` used to bind the unspecified address. The tunnel does not authenticate its
clients and forwards the upstream proxy credentials, so anyone who could route to the host
could tunnel through it - inside Docker that means every container on the same network, and
every peer on the LAN once the port is published.

## Docker (recommended)

```bash
bash scripts/repro/run.sh
```

Two containers on one bridge network. The victim keeps the upstream proxy and the target on
its own loopback and exposes only the tunnel; the attacker is a separate host with no
credentials. The script runs both bindings and prints a verdict:

1. `hostname: '0.0.0.0'`, the pre-fix binding - the attacker is expected to tunnel through.
2. the current default - the attacker is expected to be refused.

## Without Docker

```bash
node --import tsx scripts/repro/local.js
```

Same scenarios, but the attacker is the host dialling its own non-loopback address. A host
firewall can block that and make step 1 inconclusive, which is why the Docker version exists.
