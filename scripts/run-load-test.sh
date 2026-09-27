#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
# Isolated deployments; never send load-test transactions to a running network.
npx hardhat test test/exchangeMatching.test.js --network hardhat --grep 'Gas metrics'
