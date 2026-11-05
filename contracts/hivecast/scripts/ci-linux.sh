#!/usr/bin/env sh
# Linux build + test for the HiveCast contract (spec #1, ticket #2).
# Run from the repository root. Exercises the public-interface test suite and
# produces the deployable WASM artifact.
set -eu

CONTRACT_DIR="contracts/hivecast"

# 1. Build the deployable WASM (requires the wasm32-unknown-unknown target).
rustup target add wasm32-unknown-unknown
RUSTFLAGS='-C link-arg=-s' cargo build \
  --manifest-path "$CONTRACT_DIR/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release

WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/hivecast.wasm"
test -f "$WASM" || { echo "WASM artifact missing: $WASM" >&2; exit 1; }
echo "WASM built: $WASM ($(wc -c < "$WASM") bytes)"

# 2. Run the public-interface test suite through the near-sdk mock VM.
cargo test --manifest-path "$CONTRACT_DIR/Cargo.toml"

echo "contract build + test OK"
