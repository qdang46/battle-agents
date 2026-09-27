#!/usr/bin/env bash
# Assert that a commit adding or changing an adapter touched no frozen surface.
#
# WHY THIS EXISTS. The plan's central architectural claim is "add feature = add
# module + register capability, zero core edits" (§12.1) and "new CLI = one
# subdirectory" (§1.1). A claim like that is only worth something if it is
# checked, and the bead ba-third-party-adapter-proof-2wp is the falsification
# test for it: the `amp` adapter is the evidence, and the question is whether
# getting it in required editing anything it should not have.
#
# The tempting way to answer that is to read the diff and judge it. That is a
# reviewer's reading, it is not reproducible, and it is exactly what the bead
# forbids: "a CI assertion ... asserting on the file list rather than on a
# reviewer's reading."
#
# THE FROZEN SET, and the reasoning for each entry:
#
#   packages/core/            AGENTS.md freezes it outright.
#   packages/cli/             idem.
#   packages/mcp-server/      idem.
#   packages/api/             The shared Application API the other three expose.
#                            The bead names it explicitly: the shipped tree has
#                            no packages/interfaces/ directory, so a check written
#                            against that name would pass vacuously and quietly.
#   packages/protocol/src/generated/action-ids.ts
#                            The one real way an adapter can violate the rule.
#                            It is a generated union, and adding to it is a hand
#                            edit to a root script. An adapter that consumes the
#                            event union contributes NO id, so an adapter change
#                            that moves this file is the signal that the adapter
#                            decided it needed to publish actions.
#
# WHY IT IS SCOPED TO COMMITS THAT TOUCH AN ADAPTER. A blanket "no commit may
# touch core" would be wrong: core work is legitimate, it is just not
# legitimate INSIDE an adapter change, because that is the claim being made.
# A commit that edits core and no adapter is not evidence about extensibility.
#
# SCOPE, and the hole in it. This reads ONE range, `ADAPTER_BOUNDARY_BASE` to
# HEAD, defaulting to HEAD~1. On a pull request with several commits that
# covers only the last one, so a core edit in an earlier commit of the same PR
# would not be seen. CI must set ADAPTER_BOUNDARY_BASE to the PR's merge base;
# the default is the local-run answer, not the CI one, and this paragraph is
# here because a guard that quietly checks less than it says is the failure this
# repository keeps paying for.
#
# The self-test at the end plants both a clean adapter commit and a violating
# one in a throwaway repository, because a guard that has only ever been green
# is indistinguishable from a guard that matches nothing.

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT
readonly BASE="${ADAPTER_BOUNDARY_BASE:-HEAD~1}"

# Frozen surfaces, as path prefixes, longest first so a prefix cannot shadow a
# more specific one. `readonly` because a list that a later line edits is a list
# nobody can reason about.
readonly FROZEN=(
  "packages/protocol/src/generated/action-ids.ts"
  "packages/core/"
  "packages/cli/"
  "packages/mcp-server/"
  "packages/api/"
)

readonly ADAPTER_PREFIX="packages/adapters/"

fail() {
  printf 'adapter-boundary FAILED: %s\n' "$1" >&2
  exit 1
}

# The files a range changed, or nothing if the range is unresolvable.
changed_files() {
  local repo="$1" base="$2"
  git -C "$repo" diff --name-only "$base"..HEAD 2>/dev/null || true
}

changed_files_matching_adapter() {
  changed_files "$1" "$2" | grep "^${ADAPTER_PREFIX}" || true
}

check_range() {
  local repo="$1" base="$2"
  local adapters violations
  adapters="$(changed_files_matching_adapter "${repo}" "${base}")"
  if [ -z "${adapters}" ]; then
    return 0
  fi

  violations=""
  local file
  while IFS= read -r file; do
    [ -n "${file}" ] || continue
    local frozen
    for frozen in "${FROZEN[@]}"; do
      case "${file}" in
        "${frozen}"*) violations+="${file}"$'\n' ;;
      esac
    done
  done < <(changed_files "${repo}" "${base}")

  if [ -n "${violations}" ]; then
    printf 'adapter-boundary: this change edits an adapter AND the frozen surface.\n' >&2
    printf '  adapter files: %s\n' "$(printf '%s' "${adapters}" | tr '\n' ' ')" >&2
    printf '  frozen files:\n%s' "${violations}" | sed 's/^/    /' >&2
    printf '\n  Adding a harness must be one subdirectory. If this change really needs\n' >&2
    printf '  to edit the frozen surface, that is an architecture finding to record --\n' >&2
    printf '  not a rule to relax.\n' >&2
    return 1
  fi
  return 0
}

# A throwaway repository with two commits, so the check is exercised on a file
# list rather than on this tree.
fixture_repo() {
  local root
  root="$(mktemp -d)"
  git -C "${root}" init -q
  git -C "${root}" config user.email t@example.com
  git -C "${root}" config user.name 'Boundary Self-Test'
  printf 'base\n' >"${root}/README.md"
  git -C "${root}" add -A
  git -C "${root}" commit -q -m base
  printf '%s' "${root}"
}

self_test() {
  local failures=0 root

  # CLEAN: an adapter and nothing frozen.
  root="$(fixture_repo)"
  mkdir -p "${root}/packages/adapters/amp/src"
  printf 'export const amp = 1;\n' >"${root}/packages/adapters/amp/src/index.ts"
  printf '{}\n' >"${root}/packages/adapters/amp/package.json"
  git -C "${root}" add -A && git -C "${root}" commit -q -m amp
  if ! check_range "${root}" HEAD~1 >/dev/null 2>&1; then
    printf '  self-test: a clean adapter commit was rejected\n' >&2
    failures=1
  fi
  rm -rf "${root}"

  # VIOLATION: the same adapter, plus one line in core.
  root="$(fixture_repo)"
  mkdir -p "${root}/packages/adapters/amp/src" "${root}/packages/core/src"
  printf 'export const amp = 1;\n' >"${root}/packages/adapters/amp/src/index.ts"
  printf '{}\n' >"${root}/packages/adapters/amp/package.json"
  printf 'export const runtime = 1;\n' >"${root}/packages/core/src/runtime.ts"
  git -C "${root}" add -A && git -C "${root}" commit -q -m 'amp plus a core edit'
  if check_range "${root}" HEAD~1 >/dev/null 2>&1; then
    printf '  self-test: an adapter commit that edited core was ACCEPTED\n' >&2
    failures=1
  fi
  rm -rf "${root}"

  # NOT AN ADAPTER COMMIT: core on its own is legitimate, and this check must
  # not be the thing that makes core work impossible.
  root="$(fixture_repo)"
  mkdir -p "${root}/packages/core/src"
  printf 'export const runtime = 1;\n' >"${root}/packages/core/src/runtime.ts"
  git -C "${root}" add -A && git -C "${root}" commit -q -m 'core only'
  if ! check_range "${root}" HEAD~1 >/dev/null 2>&1; then
    printf '  self-test: a core-only commit was rejected, so this guard would block core work\n' >&2
    failures=1
  fi
  rm -rf "${root}"

  if [ "${failures}" -ne 0 ]; then
    printf 'adapter-boundary self-test FAILED.\n' >&2
    return 1
  fi
  printf 'adapter-boundary self-test ok: clean passes, a core edit alongside an adapter is caught, core alone is untouched.\n'
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi

cd "${REPO_ROOT}"

if ! git rev-parse --verify "${BASE}" >/dev/null 2>&1; then
  fail "base ref '${BASE}' does not resolve. Set ADAPTER_BOUNDARY_BASE to a ref that exists (CI: the PR's merge base)."
fi

if ! check_range "${REPO_ROOT}" "${BASE}"; then
  exit 1
fi

printf 'adapter-boundary: no adapter change touched core/, api/, cli/, mcp-server/ or the generated action ids (%s..HEAD).\n' "${BASE}"
