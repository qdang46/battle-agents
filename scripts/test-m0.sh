#!/usr/bin/env bash
#
# Canonical M0 test pipeline — plan section 40.
#
#   The stage set is NOT listed here. scripts/stages.manifest is the single
#   definition, and the preflight below fails if this file's CANONICAL_STAGES or
#   the run_stage dispatch disagree with it. An earlier version of this header
#   enumerated the stages in prose and went stale at eight of them, which the
#   three-way check cannot catch: all three real views agreed while only the
#   sentence was wrong.
#
# Contributors run this file directly through `pnpm test:m0`; CI runs this same
# file as the command of the compose `m0-test-runner` service. Same file, same
# stage order, same exit code in both places — that is the whole point of the
# local/CI parity contract.
#
# Guarantees this script is responsible for:
#   - stages execute in the order above, never out of order;
#   - every executed stage writes a marker under `.tmp/m0-stages/`, and a run may
#     only report the M0 gate green when a marker exists for every stage in the
#     manifest, so
#     no stage can be skipped silently;
#   - a red stage names itself in the summary, in the stderr verdict, and in the
#     exit code.
#
# A stage whose implementation does not exist in this tree yet is reported as
# `unimplemented` and fails the run. That is deliberate: a missing stage and a
# passing stage must never look the same.

set -Eeuo pipefail

SCRIPT_NAME="$(basename -- "${BASH_SOURCE[0]}")"
readonly SCRIPT_NAME
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT

readonly PIPELINE_ID="m0"
readonly MARKER_SUBDIR=".tmp/m0-stages"
readonly MARKER_SUFFIX=".marker"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID

# Order is the contract. Do not reorder without amending plan section 40.
readonly CANONICAL_STAGES=(
  build
  codegen-drift
  compose
  migrations
  seed
  unit
  integration
  schema-drift
  typecheck
  architecture
  adapter-boundary
  schema-hygiene
  removal-test
  moltbook-claims
  docs
  watchlist-claims
  pooled-driver
  asset-licenses
  license
  e2e-smoke
)

readonly STATUS_PASS="pass"
readonly STATUS_FAIL="fail"
readonly STATUS_UNIMPLEMENTED="unimplemented"

readonly COMPOSE_BASE_FILE="compose.yaml"
readonly COMPOSE_TEST_FILE="compose.test.yaml"
readonly COMPOSE_PROFILE="test"
# Distinct from the base stack's own `test-runner` service so the two files
# compose by addition instead of one overwriting the other.
readonly TEST_RUNNER_SERVICE="m0-test-runner"

readonly PG_HOST_ENV="M0_PG_HOST"
readonly PG_PORT_ENV="M0_PG_PORT"
readonly PG_PUBLISHED_PORT_ENV="M0_PG_PUBLISHED_PORT"
readonly PG_PUBLISHED_PORT_DEFAULT="5433"
readonly PG_WAIT_ATTEMPTS=30
readonly PG_WAIT_INTERVAL_SECONDS=1

readonly IN_CONTAINER_ENV="M0_IN_CONTAINER"
readonly STAGES_ENV="M0_STAGES"
readonly RESUME_ENV="M0_RESUME"
readonly MARKER_DIR_ENV="M0_MARKER_DIR"
readonly DATABASE_URL_ENV="M0_DATABASE_URL"

# Beads that own each delegated stage, so a red pipeline names who owes the work.
readonly OWNER_DB="ba-db-schema-drizzle-fki"
readonly OWNER_REMOVAL_TEST="ba-removal-test-e33"
readonly OWNER_LICENSE="ba-license-hygiene-qy7"
readonly OWNER_MOLTBOOK="ba-moltbook-verification-0zc"
readonly OWNER_DOCS="ba-contributor-onboarding-tc9"
readonly OWNER_WATCHLIST="ba-watchlist-space-molt-5v4"
readonly OWNER_ASSETS="ba-asset-shortlist-x2a"
readonly OWNER_POOLED_DRIVER="ba-neon-cloud-deploy-zn4"
readonly OWNER_ADAPTER_BOUNDARY="ba-third-party-adapter-proof-2wp"
readonly OWNER_WEB="ba-web-ui-surface-t3w"
readonly OWNER_CONTRACT="ba-contract-extension-api-w29"
readonly OWNER_ARCHITECTURE="ba-dependency-rules-os1"
readonly OWNER_SCHEMA_HYGIENE="ba-db-schema-drizzle-fki"

SELECTED_STAGES=()
RESULT_STATUS=()
RESULT_ELAPSED=()
RESULT_NOTE=()
COMPOSE_FILE_ARGS=()
CANDIDATE_FOUND=0
STAGE_STATUS="$STATUS_FAIL"

cd -- "$REPO_ROOT"

# --- output helpers ----------------------------------------------------------

note() {
  printf '%s\n' "$*"
}

fail() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

# --- environment resolution --------------------------------------------------

# Inside the compose `test-runner` service the stack is already up, so the compose
# stage verifies it rather than starting it. That keeps `docker compose up` in
# the chain in both environments instead of letting the container re-enter Docker.
running_in_test_runner() {
  [ "${!IN_CONTAINER_ENV:-}" = "1" ]
}

resolve_compose_file_args() {
  COMPOSE_FILE_ARGS=()
  if [ -f "$COMPOSE_BASE_FILE" ]; then
    COMPOSE_FILE_ARGS+=(-f "$COMPOSE_BASE_FILE")
  fi
  COMPOSE_FILE_ARGS+=(-f "$COMPOSE_TEST_FILE")
}

# The compose file is contributed by ba-docker-local-dev-y28; this script only
# reads it, so its absence is not fatal while the stack lives in the test profile.
has_compose_files() {
  local file_arg
  for file_arg in "${COMPOSE_FILE_ARGS[@]}"; do
    if [ -f "${file_arg#-f}" ]; then
      return 0
    fi
  done
  return 1
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    fail "docker is required to run the M0 pipeline (https://docs.docker.com/get-docker/)"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    fail "docker compose v2+ is required to run the M0 pipeline"
  fi
}

# Migrations, seed and integration all talk to the compose Postgres. An explicit
# DATABASE_URL in the environment (the test-runner service sets one) wins, so the
# in-network URL is never overwritten with the published-port URL.
default_test_database_url() {
  local published_port="${!PG_PUBLISHED_PORT_ENV:-$PG_PUBLISHED_PORT_DEFAULT}"
  printf 'postgres://postgres:postgres@127.0.0.1:%s/battle_test\n' "$published_port"
}

setup_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    DATABASE_URL="${!DATABASE_URL_ENV:-$(default_test_database_url)}"
  fi
  export DATABASE_URL
}

# --- stage markers -----------------------------------------------------------

marker_dir() {
  if [ -n "${!MARKER_DIR_ENV:-}" ]; then
    printf '%s\n' "${!MARKER_DIR_ENV}"
    return
  fi
  printf '%s\n' "$REPO_ROOT/$MARKER_SUBDIR"
}

marker_path() {
  printf '%s/%s%s\n' "$(marker_dir)" "$1" "$MARKER_SUFFIX"
}

marker_field() {
  local path
  path="$(marker_path "$1")"
  if [ ! -f "$path" ]; then
    return 1
  fi
  grep -m1 "^$2=" "$path" | cut -d= -f2- || true
}

# What the marker is allowed to vouch for. A `pass` marker says "this stage
# passed", and without a fingerprint it keeps saying that no matter what the
# code has become since. Markers live under .tmp/ which is gitignored and never
# cleaned, and CI uploads them as gate evidence, so a stale pass is worse than
# no marker: it is indistinguishable from a real one.
#
# HEAD plus a hash of TRACKED modifications covers both ways code can change
# under a resume: committing moves HEAD, editing without committing changes the
# dirty set. Untracked files are excluded on purpose, because a run creates
# dist/ and .tmp/ output and the fingerprint must stay stable for the whole run.
code_fingerprint() {
  local head dirty
  head=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'no-head')
  dirty=$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no 2>/dev/null \
    | shasum -a 256 2>/dev/null | cut -d" " -f1)
  printf "%s:%s" "$head" "${dirty:-clean}"
}

write_marker() {
  local stage=$1 status=$2 started=$3 elapsed=$4
  local dir
  dir="$(marker_dir)"
  mkdir -p -- "$dir"
  {
    printf 'stage=%s\n' "$stage"
    printf 'status=%s\n' "$status"
    printf 'run_id=%s\n' "$RUN_ID"
    printf 'started=%s\n' "$started"
    printf 'elapsed_seconds=%s\n' "$elapsed"
    printf 'fingerprint=%s\n' "$(code_fingerprint)"
  } >"$(marker_path "$stage")"
}

# A fresh run must not inherit markers from a previous one, otherwise an
# unexecuted stage could pass the completeness check below.
prepare_marker_dir() {
  mkdir -p -- "$(marker_dir)"
  if [ "${!RESUME_ENV:-}" = "1" ]; then
    return
  fi
  local path
  for path in "$(marker_dir)"/*"$MARKER_SUFFIX"; do
    if [ -e "$path" ]; then
      rm -f -- "$path"
    fi
  done
}

# --- stage selection ---------------------------------------------------------

is_known_stage() {
  local candidate=$1 known
  for known in "${CANONICAL_STAGES[@]}"; do
    if [ "$known" = "$candidate" ]; then
      return 0
    fi
  done
  return 1
}

# M0_STAGES is the resume lever: a contributor re-running after a late failure
# passes "unit integration". Selection is re-sorted into canonical order so the
# chain can never execute out of sequence.
resolve_selected_stages() {
  local requested="${!STAGES_ENV:-}"
  local normalized=${requested//,/ }
  local -a requested_names=()
  SELECTED_STAGES=()
  if [ -z "$normalized" ]; then
    SELECTED_STAGES=("${CANONICAL_STAGES[@]}")
    return
  fi
  read -r -a requested_names <<<"$normalized"
  local name known
  for name in "${requested_names[@]}"; do
    if ! is_known_stage "$name"; then
      fail "unknown stage '$name'; valid stages: ${CANONICAL_STAGES[*]}"
    fi
  done
  for known in "${CANONICAL_STAGES[@]}"; do
    for name in "${requested_names[@]}"; do
      if [ "$known" = "$name" ]; then
        SELECTED_STAGES+=("$known")
      fi
    done
  done
}

stages_not_selected() {
  local known name not_selected=()
  for known in "${CANONICAL_STAGES[@]}"; do
    for name in "${SELECTED_STAGES[@]}"; do
      if [ "$known" = "$name" ]; then
        continue 2
      fi
    done
    not_selected+=("$known")
  done
  printf '%s' "${not_selected[*]:-}"
}

# --- delegated stage resolution ---------------------------------------------

pnpm_script_defined() {
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(manifest.scripts && manifest.scripts[process.argv[2]] ? 0 : 1);
  ' "$REPO_ROOT/package.json" "$1"
}

run_pnpm_script() {
  local name=$1
  if ! pnpm_script_defined "$name"; then
    return 0
  fi
  CANDIDATE_FOUND=1
  printf '  -> pnpm run %s\n' "$name"
  pnpm run "$name"
}

run_repo_script() {
  local path=$1
  if [ ! -f "$REPO_ROOT/$path" ]; then
    return 0
  fi
  CANDIDATE_FOUND=1
  printf '  -> bash %s\n' "$path"
  bash "$REPO_ROOT/$path"
}

run_candidate() {
  case "$1" in
    script:*) run_pnpm_script "${1#script:}" ;;
    file:*) run_repo_script "${1#file:}" ;;
    *) fail "unknown stage candidate kind: $1" ;;
  esac
}

# Availability and success are separate facts. Deciding them by exit code alone
# would misread a command that legitimately exits 127 — a missing binary inside
# a stage, say — as "this candidate does not exist" and report the stage as
# unimplemented, hiding the real failure.
run_delegated() {
  local stage=$1 owner=$2
  shift 2
  local candidate exit_code
  CANDIDATE_FOUND=0
  for candidate in "$@"; do
    exit_code=0
    run_candidate "$candidate" || exit_code=$?
    if [ "$CANDIDATE_FOUND" = "1" ]; then
      return "$exit_code"
    fi
  done
  stage_unimplemented "$stage" "$owner"
}

stage_unimplemented() {
  STAGE_STATUS="$STATUS_UNIMPLEMENTED"
  printf '  %s has no implementation in this tree yet (owned by %s).\n' "$1" "$2"
  if [ -n "${3:-}" ]; then
    printf '  Reason: %s\n' "$3"
  fi
  printf '  Reported red on purpose: an absent stage must not read as a passing one.\n'
  return 1
}

# A vitest command can exist while the suite it points at has no files yet, and
# vitest exits 1 on "No test files found". That is neither a pass nor a real
# failure: it means the stage has no implementation yet, which is the state
# STATUS_UNIMPLEMENTED exists for. Counting the files first keeps an empty suite
# from being reported green, and keeps it from being reported broken.
count_stage_test_files() {
  local stage_dir=$1
  find "$REPO_ROOT/tests/$stage_dir" -name '*.test.ts' -type f 2>/dev/null | wc -l | tr -d ' '
}

run_delegated_test_stage() {
  local stage=$1 owner=$2 stage_dir=$3
  shift 3
  if [ "$(count_stage_test_files "$stage_dir")" = "0" ]; then
    stage_unimplemented "$stage" "$owner" "tests/$stage_dir has no *.test.ts yet"
    return 1
  fi
  run_delegated "$stage" "$owner" "$@"
}

# --- stage implementations ---------------------------------------------------

wait_for_test_postgres() {
  local host="${!PG_HOST_ENV:-}" port="${!PG_PORT_ENV:-}" attempt
  if [ -z "$host" ] || [ -z "$port" ]; then
    note "  $PG_HOST_ENV/$PG_PORT_ENV are unset; skipping the reachability probe."
    return 0
  fi
  for ((attempt = 1; attempt <= PG_WAIT_ATTEMPTS; attempt++)); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
      return 0
    fi
    sleep "$PG_WAIT_INTERVAL_SECONDS"
  done
  note "  Postgres at $host:$port did not accept connections within ${PG_WAIT_ATTEMPTS}s."
  return 1
}

start_compose_stack() {
  resolve_compose_file_args
  if ! has_compose_files; then
    note "  Neither $COMPOSE_TEST_FILE nor $COMPOSE_BASE_FILE exists in this tree."
    return 1
  fi
  require_docker
  # The test profile is deliberately not activated here: it holds the test-runner
  # service, and bringing that up from inside the pipeline would start a second
  # copy of the pipeline against itself. CI activates the profile explicitly.
  printf '  -> docker compose %s up -d --wait\n' "${COMPOSE_FILE_ARGS[*]}"
  # Capture the status first. "note" is a printf, so when it was the last
  # statement the function returned 0 and a failed "docker compose up" was
  # reported as a passing stage. The pipeline calls run_stage behind "|| exit",
  # which also disables errexit inside the function, so the status has to be
  # carried explicitly rather than inherited.
  local compose_status=0
  docker compose "${COMPOSE_FILE_ARGS[@]}" up -d --wait || compose_status=$?
  if [ "$compose_status" -ne 0 ]; then
    printf '  docker compose could not bring the stack up (exit %s).\n' "$compose_status" >&2
    return "$compose_status"
  fi
  note "  to run this same pipeline in the $COMPOSE_PROFILE profile instead:"
  note "     docker compose ${COMPOSE_FILE_ARGS[*]} --profile $COMPOSE_PROFILE run --rm $TEST_RUNNER_SERVICE"
}

run_stage_compose() {
  if running_in_test_runner; then
    note "  stack already up: this run is inside the compose $TEST_RUNNER_SERVICE service."
    wait_for_test_postgres
    return $?
  fi
  start_compose_stack || return $?
  # `docker compose up --wait` returning 0 means the containers are healthy. It
  # does not mean this project can reach the database it published: if the port
  # was already taken, Compose starts the container, the container reports
  # healthy, and the host port keeps answering for whoever owned it. Every
  # later stage then fails on a password error against a server nobody here
  # started, and the cause is three stages away from the message. So the
  # endpoint is proved here, against the same URL migrations and seed will use.
  printf '  -> checking the published database is actually reachable\n'
  pnpm exec tsx scripts/check-postgres.ts
}

run_stage_migrations() {
  run_delegated migrations "$OWNER_DB" file:scripts/migrate.sh script:db:migrate
  # Migrate alone exits 0 when it decides there is nothing to do, and its
  # bookkeeping lives in a separate "drizzle" schema, so dropping only the
  # public schema left it believing 0000 had already been applied. A table
  # existence check catches that here, with a clear message, instead of letting
  # it surface later as a confusing seed failure.
  printf '  -> checking the migrated tables exist\n'
  pnpm run db:verify -- --tables-only
}

run_stage_seed() {
  run_delegated seed "$OWNER_DB" file:scripts/seed.sh script:db:seed
  # db:verify asserts data invariants as well as shape, so it needs the seed in
  # place. It is here rather than in the migrations stage for that reason.
  printf '  -> pnpm run db:verify\n'
  pnpm run db:verify
}

# tsc runs first so a type error is reported as a unit-stage failure rather than
# surfacing later as a confusing removal-test or integration failure.
run_stage_schema_hygiene() {
  # Guards credential hygiene, which schema-drift cannot: that stage checks that
  # the migration matches the schema, and a plaintext token column is a perfectly
  # consistent migration.
  run_delegated schema-hygiene "$OWNER_SCHEMA_HYGIENE" script:schema-hygiene
}

run_stage_architecture() {
  # Runs the rule engine over the REAL tree. The fixture test proves each rule
  # fires; this proves the repository obeys them, and it survives the deletion of
  # any single test file.
  run_delegated architecture "$OWNER_ARCHITECTURE" script:architecture
}

migrated_object_names_absent_from_sql() {
  # Every check(...) and index(...) the schema source names, minus the ones that
  # appear in some committed migration. Drizzle emits checks as
  # CONSTRAINT "name" CHECK and indexes as CREATE [UNIQUE] INDEX "name", so the
  # migration side is a plain substring search over the concatenated SQL.
  #
  # The schema glob has to be recursive. A first version read
  # packages/db/src/schema/*.ts and found nothing missing, which read like a
  # pass: the features subdirectory holds the money constraint, so the one
  # declaration the check most needed to see was the one it never loaded.
  local schema_sql committed_sql
  schema_sql=$(find "$REPO_ROOT/packages/db/src/schema" -name '*.ts' -exec cat {} + 2>/dev/null)
  committed_sql=$(find "$REPO_ROOT/packages/db/migrations" -name '*.sql' -exec cat {} + 2>/dev/null)

  [ -n "$schema_sql" ] || return 0
  [ -n "$committed_sql" ] || return 0

  printf '%s\n' "$schema_sql" |
    grep -oE "(check|index)\(\s*'[a-z0-9_]+'" |
    sed -E "s/.*'([a-z0-9_]+)'/\1/" |
    sort -u |
    while IFS= read -r object_name; do
      [ -n "$object_name" ] || continue
      case "$committed_sql" in
        *"$object_name"*) ;;
        *) printf '    %s\n' "$object_name" ;;
      esac
    done
}

run_stage_build() {
  # The web app compiled or it did not, and nothing else in the pipeline
  # found out: tsc and vitest both read tsconfig, and neither reads
  # next.config.mjs or webpack's extension mapping. For several commits
  # `next build` failed on an unresolvable `@/...js` import while every other
  # stage was green, and a build that no gate runs is the same defect as a gate
  # that checks nothing.
  local build_status=0
  ( cd "$REPO_ROOT" && pnpm -r build ) >/dev/null 2>&1 || build_status=$?

  if [ "$build_status" -ne 0 ]; then
    STAGE_STATUS="$STATUS_FAIL"
    printf '  the workspace did not build (exit %s).\n' "$build_status"
    printf '  Run `pnpm -r build` and read the compiler output; the output above\n'
    printf '  is suppressed because it is long and the stage summary is not.\n'
    return 1
  fi
}

run_stage_codegen_drift() {
  # The action-id union is generated from each feature's manifest and committed,
  # so it can go stale the same way a migration artifact does: a feature adds an
  # id to its manifest, runs nothing, and ships. The union `act()` is checked
  # against is then a list that was correct the day it was written, and the
  # guarantee it exists to provide — that `act('typo.id')` will not compile —
  # stops covering the new feature. Nothing else here notices. The feature's own
  # tests pass, typecheck passes against the stale union, architecture passes,
  # and the gate reports green while checking nothing about the id just added.
  #
  # It is the same shape as schema-drift, and for the same reason: the committed
  # artifact is the thing under test, and a check that regenerates and repairs
  # would pass on its own repair next time. The script restores the tree either
  # way, so running the gate does not quietly fix what it is meant to catch.
  #
  # ba-risk-gates-e74 RISK 3. It runs immediately after `build` because unit,
  # integration and typecheck all read the union this verifies.
  local drift_status=0
  ( cd "$REPO_ROOT" && bash scripts/check-codegen-fresh.sh ) || drift_status=$?

  if [ "$drift_status" -ne 0 ]; then
    STAGE_STATUS="$STATUS_FAIL"
    printf '  the committed action-id union is stale (exit %s).\n' "$drift_status"
    printf '  Run `pnpm codegen` and commit the result. The diff the check would\n'
    printf '  have produced is above; the tree has been left as it was found.\n'
    return 1
  fi
}

run_stage_schema_drift() {
  # A green integration suite can describe a schema the code no longer matches.
  # The integration test reads the DATABASE, which drizzle builds from the
  # COMMITTED migration artifact, not from the schema source. Editing
  # packages/db/src/schema/*.ts without regenerating leaves the artifact
  # stale, the database stale, and the test confidently confirming the stale
  # shape, which is the worst failure mode a test suite can have.
  #
  # Two conditions, and both are needed. drizzle-kit prompts interactively when
  # it wants to create a new migration, and it cannot prompt without a TTY, so a
  # drifted schema fails generation outright. But relying on that alone would be
  # an accident of the tool, so the tree must also be clean afterwards: if
  # generation ever succeeds while writing files, those files are an
  # uncommitted migration and belong in a commit, not in a test run.
  local generated_status=0
  ( cd "$REPO_ROOT" && pnpm db:generate ) >/dev/null 2>&1 || generated_status=$?

  local pending
  pending=$(git -C "$REPO_ROOT" status --porcelain -- packages/db 2>/dev/null)

  if [ "$generated_status" -ne 0 ]; then
    STAGE_STATUS="$STATUS_FAIL"
    printf '  db:generate exited %s.\n' "$generated_status"
    printf '  Usually this means the schema source moved and the committed migration\n'
    printf '  no longer matches it. Run pnpm db:generate locally with a TTY, review the\n'
    printf '  generated migration, and commit it before the pipeline can pass.\n'
    return 1
  fi

  if [ -n "$pending" ]; then
    STAGE_STATUS="$STATUS_FAIL"
    printf '  schema drift: packages/db has uncommitted changes after db:generate.\n'
    printf '%s\n' "$pending"
    printf '  Commit the regenerated migration rather than letting a test discover it.\n'
    return 1
  fi

  # Both conditions above can pass while the committed SQL is wrong. drizzle-kit
  # diffs the schema source against the meta/*_snapshot.json files, never against
  # the emitted .sql, so a hand-edited migration is invisible to it: generate
  # prints "No schema changes", the tree is clean, and this stage reports the
  # artifact is in sync. The database is then built from the edited SQL, and an
  # integration suite reading it confirms the wrong shape with total confidence.
  #
  # So the artifact is checked against the source directly: every constraint and
  # index the schema names has to appear in some committed migration. This is
  # the one direction that matters. A migration containing MORE than the schema
  # declares is a dropped column, which no name comparison can detect, and the
  # honest thing is to say so rather than imply the check is complete.
  local missing_artifacts
  missing_artifacts=$(migrated_object_names_absent_from_sql)

  if [ -n "$missing_artifacts" ]; then
    STAGE_STATUS="$STATUS_FAIL"
    printf '  schema drift: the committed migration does not contain these objects.\n'
    printf '  The schema source declares them, so the SQL artifact and the source\n'
    printf '  disagree in a way db:generate cannot see.\n'
    printf '%s\n' "$missing_artifacts"
    printf '  Regenerate with pnpm db:generate, review the SQL, and commit it.\n'
    return 1
  fi

  STAGE_STATUS="$STATUS_PASS"
  printf '  migration artifact is in sync with the schema source.\n'
  return 0
}

run_stage_typecheck() {
  run_delegated typecheck "$OWNER_CONTRACT" script:typecheck
}

run_stage_unit() {
  # Scoped to the unit config on purpose. "pnpm test" runs the root vitest
  # config, whose glob spans the whole repository, so the Postgres-dependent
  # integration suite executed inside the unit stage as well. Section 40 says
  # any red step blocks merge, and that only holds if the stages cannot overlap.
  # Typecheck has its own stage, so it is not repeated here.
  printf '  -> pnpm run test:unit\n'
  pnpm run test:unit
}

run_stage_integration() {
  run_delegated_test_stage integration "$OWNER_DB" integration script:test:integration file:scripts/integration-test.sh
}

run_stage_removal_test() {
  run_delegated removal-test "$OWNER_REMOVAL_TEST" script:removal-test file:scripts/removal-test.sh
}

run_stage_moltbook_claims() {
  # Every Moltbook mechanic the plan states, re-checked against the note that
  # actually read the source, plus a resolution of every cited file:line against
  # the checkout. The check existed and passed while nothing invoked it, which is
  # the failure mode ba-risk-gates-e74 was opened over: a gate that is not wired
  # is a comment. It ships with its own self-test asserting every sub-check goes
  # red on the mutation meant to defeat it, so a future edit cannot quietly turn
  # it into a script that exits 0.
  run_delegated moltbook-claims "$OWNER_MOLTBOOK" script:check:moltbook
}

run_stage_docs() {
  # A doc that drifts from the tree passes every review, because a reviewer
  # reads prose and not the filesystem. The script asserts that the README's
  # links resolve, that the advertised good-first-issues exist in the tracker,
  # that the licence claim is one this repository actually holds, and that the
  # documented setup steps match what the tree does.
  run_delegated docs "$OWNER_DOCS" script:check:docs
}

run_stage_watchlist_claims() {
  # Resolves every SpaceMolt citation in the research note against the checkout
  # and asserts the decision is recorded as ADOPT, KEEP or DEFER with a stated
  # consequence. The clause that earns it is the cross-check: a design doc
  # leaning on an unverified SpaceMolt mechanic is how a phantom constraint gets
  # built, and that is the failure the Moltbook check guards on the first watch
  # target.
  run_delegated watchlist-claims "$OWNER_WATCHLIST" script:check:watchlist
}

run_stage_pooled_driver() {
  # §7.1's beginner trap: a connection constructed per request rather than a
  # pooled one. The grep half catches a route opening its own connection; the
  # identity assertion in tests/integration/shared-runtime-fold.test.ts is the
  # half that earns it, because a hoisted client that looks right in review and
  # exhausts connections at 2000 writes/s is invisible to a grep.
  run_delegated pooled-driver "$OWNER_POOLED_DRIVER" script:check:pooled-driver
}

run_stage_adapter_boundary() {
  # The extensibility claim, asserted on a file list. Plan section 12.1 says
  # "add feature = add module + register capability, zero core edits" and
  # section 1.1 says "new CLI = one subdirectory"; this is the mechanical half
  # of both, and it is scoped to commits that touch an adapter on purpose -- a
  # blanket ban on touching core would block legitimate core work, which is not
  # evidence about extensibility either way.
  run_delegated adapter-boundary "$OWNER_ADAPTER_BOUNDARY" script:check:adapter-boundary
}

run_stage_asset_licenses() {
  # Per-pack asset licences, separate from the vendored SOURCE licences
  # check-licenses.sh covers. An asset pack is third-party art with its own
  # licence file, and a copyleft pack sitting in an MIT repository contaminates
  # it — so the two are never inferred from one another. The rule with teeth is
  # that the licence RECORDED IN THE SHORTLIST matches the text actually shipped
  # beside the pack: a file merely existing is not verification, and a pack
  # relicensed upstream between selection and merge still has a LICENSE.txt.
  run_delegated asset-licenses "$OWNER_ASSETS" script:check:assets
}

run_stage_license() {
  run_delegated license "$OWNER_LICENSE" file:scripts/check-licenses.sh script:check:licenses
}

run_stage_e2e_smoke() {
  run_delegated_test_stage e2e-smoke "$OWNER_WEB" e2e file:scripts/e2e-smoke.sh script:test:e2e
}

# --- execution ---------------------------------------------------------------

# The stage-name to runner mapping is the contract, so it is written out rather
# than derived by name: a stage added to CANONICAL_STAGES without a runner here
# fails loudly instead of resolving to nothing.
run_stage() {
  case "$1" in
    compose) run_stage_compose ;;
    migrations) run_stage_migrations ;;
    seed) run_stage_seed ;;
    architecture) run_stage_architecture ;;
    adapter-boundary) run_stage_adapter_boundary ;;
    schema-hygiene) run_stage_schema_hygiene ;;
    build) run_stage_build ;;
    codegen-drift) run_stage_codegen_drift ;;
    schema-drift) run_stage_schema_drift ;;
    typecheck) run_stage_typecheck ;;
    unit) run_stage_unit ;;
    integration) run_stage_integration ;;
    removal-test) run_stage_removal_test ;;
    moltbook-claims) run_stage_moltbook_claims ;;
    docs) run_stage_docs ;;
    watchlist-claims) run_stage_watchlist_claims ;;
    pooled-driver) run_stage_pooled_driver ;;
    asset-licenses) run_stage_asset_licenses ;;
    license) run_stage_license ;;
    e2e-smoke) run_stage_e2e_smoke ;;
    *) fail "no runner registered for stage '$1'" ;;
  esac
}

# Resuming reuses a green marker from an earlier run so a late failure does not
# cost the whole chain again. Only a `pass` marker is reusable.
already_completed() {
  local stage=$1
  if [ "${!RESUME_ENV:-}" != "1" ]; then
    return 1
  fi
  [ "$(marker_field "$stage" status || true)" = "$STATUS_PASS" ] || return 1

  local recorded current
  recorded=$(marker_field "$stage" fingerprint || true)
  current=$(code_fingerprint)
  if [ -z "$recorded" ]; then
    printf '  stage %s: marker predates fingerprinting, rerunning.\n' "$stage"
    return 1
  fi
  if [ "$recorded" != "$current" ]; then
    printf '  stage %s: marker was written for different code, rerunning.\n' "$stage"
    return 1
  fi
  return 0
}

execute_stage() {
  local stage=$1 index=$2
  local started elapsed_seconds exit_code=0 status note_text=""
  started=$(date -u +%s)
  printf '\n=== %s stage %d/%d: %s ===\n' "$PIPELINE_ID" "$index" "${#SELECTED_STAGES[@]}" "$stage"
  STAGE_STATUS="$STATUS_FAIL"
  run_stage "$stage" || exit_code=$?
  elapsed_seconds=$(($(date -u +%s) - started))
  status=$STAGE_STATUS
  if [ "$exit_code" -eq 0 ]; then
    status="$STATUS_PASS"
  fi
  if [ "$status" = "$STATUS_UNIMPLEMENTED" ]; then
    note_text="no implementation in tree"
  fi
  write_marker "$stage" "$status" "$started" "$elapsed_seconds"
  RESULT_STATUS+=("$status")
  RESULT_ELAPSED+=("$elapsed_seconds")
  RESULT_NOTE+=("$note_text")
  printf '\n  [%s] %s (%ss)\n' "$stage" "$status" "$elapsed_seconds"
}

record_resumed_stage() {
  local stage=$1
  RESULT_STATUS+=("$STATUS_PASS")
  RESULT_ELAPSED+=("0")
  RESULT_NOTE+=("resumed from marker run $(marker_field "$stage" run_id || printf 'unknown')")
  printf '\n=== %s stage %s: %s (resumed) ===\n' "$PIPELINE_ID" "$stage" "$STATUS_PASS"
}

# --- reporting ---------------------------------------------------------------

print_summary() {
  local index stage
  printf '\n=== %s stage summary (run %s) ===\n' "$PIPELINE_ID" "$RUN_ID"
  printf '  %-14s %-14s %-6s %s\n' STAGE STATUS ELAPSED NOTE
  for index in "${!SELECTED_STAGES[@]}"; do
    stage="${SELECTED_STAGES[$index]}"
    printf '  %-14s %-14s %-6s %s\n' \
      "$stage" "${RESULT_STATUS[$index]}" "${RESULT_ELAPSED[$index]}" "${RESULT_NOTE[$index]}"
  done
  note "  markers: $(marker_dir)"
}

# Green requires every canonical stage to have run and passed. A partial run is
# never reported as the M0 gate being green.
final_verdict() {
  local index stage
  local -a red_stages=()
  for index in "${!SELECTED_STAGES[@]}"; do
    stage="${SELECTED_STAGES[$index]}"
    if [ "${RESULT_STATUS[$index]}" != "$STATUS_PASS" ]; then
      red_stages+=("$stage")
    fi
  done
  local not_selected
  not_selected="$(stages_not_selected)"
  if [ "${#red_stages[@]}" -eq 0 ] && [ -z "$not_selected" ]; then
    printf '%s pipeline GREEN: %d/%d stages passed.\n' \
      "$PIPELINE_ID" "${#SELECTED_STAGES[@]}" "${#CANONICAL_STAGES[@]}"
    return 0
  fi
  if [ "${#red_stages[@]}" -gt 0 ]; then
    printf '%s pipeline RED: failing stage(s): %s\n' "$PIPELINE_ID" "${red_stages[*]}" >&2
  fi
  if [ -n "$not_selected" ]; then
    printf '%s pipeline RED: stage(s) not run: %s\n' "$PIPELINE_ID" "$not_selected" >&2
  fi
  return 1
}

main() {
  # Preflight. If the stage set disagrees across the manifest, CANONICAL_STAGES
  # and the run_stage dispatch, running the stages would report green for a set
  # nobody intended, so this runs before the first stage rather than as one.
  if ! bash "${REPO_ROOT}/scripts/check-stage-manifest.sh"; then
    printf 'pipeline aborted before running any stage: the stage set is inconsistent.\n' >&2
    return 1
  fi

  prepare_marker_dir
  resolve_selected_stages
  setup_database_url
  note "$PIPELINE_ID pipeline: ${SELECTED_STAGES[*]}"
  local index stage
  for index in "${!SELECTED_STAGES[@]}"; do
    stage="${SELECTED_STAGES[$index]}"
    if already_completed "$stage"; then
      record_resumed_stage "$stage"
    else
      execute_stage "$stage" "$((index + 1))"
    fi
  done
  print_summary
  local verdict=0
  final_verdict || verdict=$?
  exit "$verdict"
}

main "$@"
