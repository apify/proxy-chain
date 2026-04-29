#!/bin/bash

echo "Starting parallel Docker tests for Node 20, 22, and 24..."

# Run builds in parallel, capture PIDs.
docker build --build-arg NODE_IMAGE=node:20.19.6-bookworm --tag proxy-chain-tests:node20 --file test/Dockerfile . && docker run --add-host localhost-test:127.0.0.1 proxy-chain-tests:node20 &
pid20=$!
docker build --build-arg NODE_IMAGE=node:22.21.1-bookworm --tag proxy-chain-tests:node22 --file test/Dockerfile . && docker run --add-host localhost-test:127.0.0.1 proxy-chain-tests:node22 &
pid22=$!
docker build --build-arg NODE_IMAGE=node:24.12.0-bookworm --tag proxy-chain-tests:node24 --file test/Dockerfile . && docker run --add-host localhost-test:127.0.0.1 proxy-chain-tests:node24 &
pid24=$!

# Wait for all and capture exit codes.
wait $pid20
ec20=$?
wait $pid22
ec22=$?
wait $pid24
ec24=$?

echo ""
echo "========== Results =========="
echo "Node 20: $([ $ec20 -eq 0 ] && echo 'PASS' || echo 'FAIL')"
echo "Node 22: $([ $ec22 -eq 0 ] && echo 'PASS' || echo 'FAIL')"
echo "Node 24: $([ $ec24 -eq 0 ] && echo 'PASS' || echo 'FAIL')"
echo "============================="

# Exit with non-zero if any failed.
exit $((ec20 + ec22 + ec24))
