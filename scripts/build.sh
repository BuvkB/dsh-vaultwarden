#!/bin/bash
# Build / prepare @dsh-external/dsh-bitwarden.
#
# The plugin ships plain ESM JavaScript (no TypeScript step): Node runs lib/
# directly. What this script does:
#   1. Links the peer dependencies the plugin imports at runtime
#      (@deepseek-ai/dsh-tools, @deepseek-ai/schemastery). The DSH loader
#      resolves symlinked plugin directories to their real path, so the plugin
#      needs its own node_modules rather than the profile's.
#   2. Syntax-checks every source file.
#   3. Best-effort install of the optional `hash-wasm` dependency, which adds
#      Argon2id KDF support (accounts whose KDF is Argon2id).
#   4. Runs the offline end-to-end test suite against a mock server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── dependency roots ─────────────────────────────────────────────────────────
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
CANDIDATES=(
  "$DSH_HOME_DIR/profiles/node_modules"
  "$DSH_HOME_DIR/profiles/web/node_modules"
  "/home/tinyog/.dsh-runtime/lib/node_modules/@deepseek-ai/dsh/node_modules"
  "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules"
)
DEP_ROOT=""
for candidate in "${CANDIDATES[@]}"; do
  if [ -d "$candidate/@deepseek-ai/dsh-tools" ] && [ -d "$candidate/@deepseek-ai/schemastery" ]; then
    DEP_ROOT="$candidate"
    break
  fi
done
if [ -z "$DEP_ROOT" ]; then
  echo "build: cannot locate @deepseek-ai/dsh-tools / @deepseek-ai/schemastery" >&2
  exit 1
fi
echo "=== dependency root: $DEP_ROOT ==="

link_pkg() {
  local name="$1"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [link, target] = process.argv.slice(1);
    if (!fs.existsSync(target)) { console.error(`build: missing dependency target ${target}`); process.exit(1); }
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.resolve(target), path.resolve(link), process.platform === "win32" ? "junction" : "dir");
  ' "node_modules/$name" "$DEP_ROOT/$name"
}

for pkg in @deepseek-ai/dsh-tools @deepseek-ai/schemastery @deepseek-ai/dsh-llm; do
  link_pkg "$pkg"
  echo "  linked $pkg"
done

# ── syntax check ─────────────────────────────────────────────────────────────
echo "=== syntax check ==="
for file in lib/*.js test/*.mjs; do
  node --check "$file"
  echo "  ok $file"
done

# ── optional Argon2id support ────────────────────────────────────────────────
# NOTE: `--legacy-peer-deps` keeps npm from auto-installing the *registry* copies
# of the @deepseek-ai peer packages, which would shadow the running host's
# versions. If any npm command runs anyway, re-link below restores them.
if [ -d node_modules/hash-wasm ]; then
  echo "=== hash-wasm present (Argon2id supported) ==="
else
  echo "=== installing optional hash-wasm (Argon2id support; failures are non-fatal) ==="
  npm install --no-save --no-audit --no-fund --loglevel=error --legacy-peer-deps hash-wasm || \
    echo "  (skipped: PBKDF2 accounts still work; Argon2id accounts will report a clear error)"
  link_pkg @deepseek-ai/dsh-tools >/dev/null
  link_pkg @deepseek-ai/schemastery >/dev/null
  link_pkg @deepseek-ai/dsh-llm >/dev/null
  echo "  re-linked host peer packages after npm install"
fi

# ── tests ────────────────────────────────────────────────────────────────────
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "=== offline end-to-end test (mock Vaultwarden) ==="
  node test/mock-e2e.test.mjs

  echo "=== live sync test (WebSocket notifications) ==="
  node test/live-sync.test.mjs

  echo "=== http api test (browser-half routes) ==="
  node test/api.test.mjs

  echo "=== cipher write-back test ==="
  node test/mutations.test.mjs

  # Cross-implementation check against the official Bitwarden CLI. It skips
  # itself (exit 0) when the CLI or openssl is unavailable.
  echo "=== official CLI interop test ==="
  node test/cli-interop.mjs

  # Browser-half test: react is provided by the platform at runtime, so these
  # are test-only dependencies and the test skips itself when they are absent.
  if [ ! -d node_modules/react ] || [ ! -d node_modules/react-test-renderer ]; then
    echo "=== installing browser-half test deps (react, react-test-renderer) ==="
    npm install --no-save --no-audit --no-fund --loglevel=error --legacy-peer-deps \
      react@18.3.1 react-test-renderer@18.3.1 >/dev/null 2>&1 || true
    link_pkg @deepseek-ai/dsh-tools >/dev/null
    link_pkg @deepseek-ai/schemastery >/dev/null
    link_pkg @deepseek-ai/dsh-llm >/dev/null
  fi
  echo "=== settings card test (browser half) ==="
  node test/client-card.test.mjs
fi

echo "=== build complete: $ROOT ==="
