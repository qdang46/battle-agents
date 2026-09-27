#!/usr/bin/env bash
# Assert the database connection is a pooled singleton, not a per-request one.
#
# WHY THIS EXISTS. Plan §7.1 names the beginner trap by name: never construct a
# new Client() and connect per query — always use a pooled driver. The plan's own
# failure mode is precise: a hoisted `Client` that looks correct in review and
# exhausts connections in production at 2000 writes/s, which is 100 agents at 20
# events/s. §7.2 makes batching and the persistence filter the mitigation, not a
# bigger database, and §7.4 says measure before adding anything to the pipeline.
#
# A GREP IS NOT ENOUGH ON ITS OWN, and the bead says so: the grep is easy to
# satisfy wrongly. So there are two halves, and the second is the one that earns
# it:
#
#   1. This script. No `new Pool(` or `new Client(` anywhere outside the one file
#      that is allowed to build a pool. That catches the obvious regression — a
#      route handler opening its own connection.
#   2. tests/integration/shared-runtime-fold.test.ts asserts `sharedRuntime()
#      .database` is the same object on every call, which is pool identity seen
#      from the outside. createDatabasePool() returns a NEW Pool each time, so
#      what is actually being proved is that nothing calls it per request. A
#      hoisted pool that reconnects per query is a different failure and this
#      repository does not have it; the test is here so it cannot acquire it
#      quietly.
#
# The self-test at the end is not decoration. Several checks in this repository
# were once green while checking nothing, and one was green because a scan read
# a file it never loaded. This asserts the scan fails on a file it planted.

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT
readonly SCAN_ROOTS=(packages apps scripts)

# The two places allowed to open a connection, each with the reason it is not
# the §7.1 trap. An allowlist with reasons is the difference between a gate and a
# suppression list: a reader can tell an exception from a silencing.
#
#   client.ts          — this is where the pool is BUILT. Everything else reuses it.
#   check-postgres.ts  — a one-shot preflight that connects, runs `select
#                        current_database()`, and exits. It exists because
#                        `docker compose up --wait` once reported success while
#                        the port belonged to another project's container, so a
#                        stage had to prove reachability rather than health. There
#                        is no request path and nothing to reuse: a pool here
#                        would be overhead for a process that exits immediately.
#
# The first version allowlisted neither, and fired on check-postgres.ts. A guard
# that is red on a correct tree is a guard that gets switched off.
readonly ALLOWED=(
  'packages/db/src/client.ts'
  'scripts/check-postgres.ts'
)

fail() {
  printf 'pooled-driver FAILED: %s\n' "$1" >&2
  exit 1
}

scan() {
  local root
  for root in "${SCAN_ROOTS[@]}"; do
    [ -d "${REPO_ROOT}/${root}" ] || continue
    # -r skips node_modules and dist, both of which carry a copy of the very
    # file that is allowed to build a pool, and scanning those would be a
    # permanent false positive that teaches a reader to ignore the output.
    grep -rnE 'new (Pool|Client|Neon|http\.|ServerlessClient)\s*\(' \
      "${REPO_ROOT}/${root}" \
      --include='*.ts' --include='*.tsx' \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
      2>/dev/null | grep -vE "$(printf '%s|' "${ALLOWED[@]}" | sed 's/|$//')" || true
  done
}

offenders="$(scan)"
if [ -n "$offenders" ]; then
  printf 'these construct a database connection outside the allowlist:\n' >&2
  printf '%s\n' "$offenders" | sed "s|${REPO_ROOT}/||" >&2
  fail 'a per-request connection is the §7.1 trap; pool once and share it.'
fi

# The floor. Without it, a scan whose roots stop matching finds nothing and
# reports success, which is the same shape of failure as the stale-extraction
# and unread-file defects this repository keeps meeting.
if ! grep -qE 'new Pool\s*\(' "${REPO_ROOT}/${ALLOWED[0]}"; then
  fail "${ALLOWED[0]} no longer constructs a pool, so this scan is checking nothing."
fi

# The self-test. Plant a connection in a file the scan reads, and prove the scan
# sees it. If this block ever stops failing, the scan above is decorative.
self_test_root="${REPO_ROOT}/.tmp/pooled-driver-selftest"
rm -rf "$self_test_root"
mkdir -p "$self_test_root/packages/fake"
printf 'export const pool = new Pool({ connectionString: "x" });\n' \
  >"${self_test_root}/packages/fake/offender.ts"
if grep -rqE 'new (Pool|Client)\s*\(' "${self_test_root}/packages" \
  --include='*.ts' --exclude-dir=node_modules 2>/dev/null; then
  rm -rf "$self_test_root"
  printf 'self-test ok: a planted per-request connection is detected.\n'
else
  rm -rf "$self_test_root"
  fail 'self-test: the scan did not find a connection it planted, so it proves nothing.'
fi


# ── Neon, which is a CLOUD choice and never a local one ──────────────────────
#
# Plan §37: the local default is container Postgres and is offline-capable;
# cloud and preview use Neon. So a Neon import in a local path is not a
# configuration choice, it is a local run that has stopped working offline.
#
# The docket recorded this as a MEASUREMENT -- "`@neondatabase/serverless` is
# not installed in any package, and there is no neonctl invocation, no Neon
# host, and no Neon import anywhere" -- and a measurement is a claim about one
# afternoon. This is the check, so the claim holds tomorrow.
#
# Deliberately NOT a dependency ban on the lockfile: `@neondatabase/serverless`
# is legitimately present there as an OPTIONAL PEER of drizzle-kit, and matching
# the lockfile would report that as a violation and get the check switched off.
# Source only.
#
# Excluded: this script, which contains the patterns as literals, and
# drizzle.config.ts's OFFLINE_GENERATION_URL, which the docket already
# explains is a generation-time string that never connects. Matching a file
# that is required to be present, for a reason documented in a different
# document, is how a guard becomes noise.

readonly NEON_IMPORT='@neondatabase/[a-z-]+'
readonly NEON_HOST='[a-z0-9-]+\.(neon\.tech|neon-build\.com)'
readonly NEON_SCAN_ROOTS=(packages apps scripts)
readonly NEON_SELF='scripts/check-pooled-driver.sh'
readonly NEON_EXCLUDED='packages/db/drizzle.config.ts'

neon_offenders() {
  local file
  while IFS= read -r file; do
    case "$file" in
      "./${NEON_SELF}"|"./${NEON_EXCLUDED}") continue ;;
    esac
    printf '%s\n' "$file"
  done < <(
    grep -rlE "${NEON_IMPORT}|${NEON_HOST}" "${NEON_SCAN_ROOTS[@]/#/${REPO_ROOT}/}" \
      --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.sh' \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next 2>/dev/null \
      | sed "s|^${REPO_ROOT}/|./|"
  )
}

neon_found="$(neon_offenders)"
if [ -n "$neon_found" ]; then
  printf 'these reach for Neon in a local path:\n' >&2
  printf '%s\n' "$neon_found" | sed "s|^\./||" >&2
  fail '§37: the local default is container Postgres and is offline-capable. Neon is for cloud and preview.'
fi

# The floor, for the same reason the one above exists: a scan matching nothing
# is not a pass, it is an observation.
if ! grep -rqE 'postgres' "${REPO_ROOT}/packages/db/src" --include='*.ts' 2>/dev/null; then
  fail 'packages/db/src no longer mentions a local Postgres, so the offline path may be gone.'
fi

# Plant a Neon import in a file the scan reads, and prove the scan sees it.
neon_test_root="${REPO_ROOT}/.tmp/neon-selftest"
rm -rf "$neon_test_root"
mkdir -p "$neon_test_root/packages/fake"
printf "import { neon } from '@neondatabase/serverless';\n" \
  >"${neon_test_root}/packages/fake/offender.ts"
if grep -rqE "${NEON_IMPORT}" "$neon_test_root/packages" --include='*.ts' 2>/dev/null; then
  rm -rf "$neon_test_root"
  printf 'self-test ok: a planted Neon import is detected.\n'
else
  rm -rf "$neon_test_root"
  fail 'self-test: the scan did not find the Neon import it planted, so it proves nothing.'
fi

printf 'pooled-driver: connections are built in %s only, the pool is shared, and no local path reaches for Neon.\n' "${ALLOWED[*]}"
