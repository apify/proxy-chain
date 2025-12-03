#!/bin/bash

echo "Starting parallel Docker tests for Node 14, 16, and 18..."

# Run builds in parallel, capture PIDs.
docker build --build-arg NODE_IMAGE=node:14.21.3-bullseye --tag proxy-chain-tests:node14 --file test/Dockerfile . && docker run proxy-chain-tests:node14 &
pid14=$!
docker build --build-arg NODE_IMAGE=node:16.20.2-bookworm --tag proxy-chain-tests:node16 --file test/Dockerfile . && docker run proxy-chain-tests:node16 &
pid16=$!
docker build --build-arg NODE_IMAGE=node:18.20.8-bookworm --tag proxy-chain-tests:node18 --file test/Dockerfile . && docker run proxy-chain-tests:node18 &
pid18=$!

# Wait for all and capture exit codes.
wait $pid14
ec14=$?
wait $pid16
ec16=$?
wait $pid18
ec18=$?

echo ""
echo "========== Results =========="
echo "Node 14: $([ $ec14 -eq 0 ] && echo 'PASS' || echo 'FAIL')"
echo "Node 16: $([ $ec16 -eq 0 ] && echo 'PASS' || echo 'FAIL')"
echo "Node 18: $([ $ec18 -eq 0 ] && echo 'PASS' || echo 'FAIL')"
echo "============================="

# Exit with non-zero if any failed.
exit $((ec14 + ec16 + ec18))
