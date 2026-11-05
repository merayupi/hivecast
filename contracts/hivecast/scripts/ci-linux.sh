#!/usr/bin/env sh
# Linux build + test entrypoint for the HiveCast contract (spec #1, ticket #2).
#
# Usage (from repository root):
#   sh contracts/hivecast/scripts/ci-linux.sh
#
# Prerequisites:
#   - rustup with the wasm32-unknown-unknown target
#   - a Linux host (near-sdk's `unit-testing` mock VM compiles C via `cc`:
#     blst, secp256k1, zstd) — this does NOT run on Windows host toolchains
#     lacking a complete mingw-w64 or MSVC Build Tools.
set -eu

CONTRACT_DIR="contracts/hivecast"

rustup target add wasm32-unknown-unknown

echo "==> Building WASM (release)"
RUSTFLAGS='-C link-arg=-s' cargo build \
  --manifest-path "$CONTRACT_DIR/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release

WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/hivecast.wasm"
test -f "$WASM" || { echo "missing $WASM" >&2; exit 1; }
echo "WASM artifact: $WASM ($(wc -c < "$WASM") bytes)"

echo "==> Running public-interface unit tests (near-sdk mock VM)"
cargo test --manifest-path "$CONTRACT_DIR/Cargo.toml" --lib

echo "==> Running real near-sandbox lifecycle tests (near-workspaces)"
cargo test --manifest-path "$CONTRACT_DIR/Cargo.toml" --test sandbox -- --nocapture

echo "==> OK"
