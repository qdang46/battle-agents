#!/usr/bin/env bash
# Per-pack asset licence tracking.
#
# WHY THIS IS NOT PART OF check-licenses.sh. That script scans vendored SOURCE
# files for SPDX headers — first-party code with a declared licence. An asset
# pack is neither: it is third-party art with its own licence file, shipped
# unchanged, and a GPL pack sitting in an MIT repository contaminates it. So the
# two are tracked separately, per plan §14 and §17.7, and never inferred from
# one another.
#
# TWO RULES, and the second is the one that matters.
#
#   1. Every directory under apps/web/public/art/ ships a LICENSE.txt. This
#      runs on every merge rather than at selection time, so a pack added
#      without one is caught here rather than at some later audit.
#   2. The licence RECORDED IN THE SHORTLIST matches the text actually shipped
#      beside that pack.
#
# Rule 2 is the one with teeth. A pack relicensed upstream between selection and
# merge still has a LICENSE.txt, so rule 1 passes, and the shortlist goes on
# asserting something untrue — which is the failure a file merely existing cannot
# see. Verification means the shipped text says what the table says.
#
# WHAT THIS DELIBERATELY DOES NOT CHECK: whether the packs look like one game.
# Plan §14 makes style consistency the actual selection criterion, and no script
# can judge it. A "style lint" would claim to check something it cannot and would
# be trusted. The shortlist declares a style per row so a human can review the
# claim; this script checks the part that is mechanical and that people actually
# get wrong.

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT
readonly ASSET_ROOT="${REPO_ROOT}/apps/web/public/art"
readonly SHORTLIST="${REPO_ROOT}/docs/design/asset-shortlist.md"
readonly MIN_PACKS=10
readonly MAX_PACKS=20

fail() {
  printf 'asset licences FAILED: %s\n' "$1" >&2
  exit 1
}

# The licence FAMILY of a shipped licence file.
#
# Matched on distinctive PHRASES, not on a licence's abbreviation — and that is a
# correction, not a style choice.
#
# THE CC0 PATTERN HAD NO TRAILING `*` FOR THE WHOLE LIFE OF THIS SCRIPT, and it
# is worth recording what that cost. `*"CC0"` means "starts with CC0", so the
# branch only ever matched a licence whose text BEGAN with the letters — which
# none of them do, because they begin with a pack name. The single pack this
# check had ever seen, tiny-swords-cc0, passed for a different reason: its text
# contains the phrase "PUBLIC DOMAIN DEDICATION", which the third alternative
# caught. Every other CC0 pack was REJECTED as "no licence this script
# recognises" — a false negative that would have had someone delete a pack that
# is properly licensed, because the gate told them it was not.
#
# So the `*` is load-bearing and the URL form is listed too: Kenney's licences
# say "License: (Creative Commons Zero, CC0)" and carry
# creativecommons.org/publicdomain/zero/1.0/, and match on neither the old
# phrase nor a bare abbreviation search that stopped at the first alternative. The first version grepped for CC0|MIT|APACHE|
# GPL|LGPL|MPL|BSD, and "GNU GENERAL PUBLIC LICENSE v3" contains NO contiguous
# "GPL": the letters are spread across three words. So replacing a pack's shipped
# licence with GPL passed the mismatch check, which is the exact failure the rule
# exists to catch. A check whose keywords have to be spelled a particular way is
# a check that misses the common case.
#
# Ordered so a longer name is tested before a shorter one it contains: LGPL
# contains "GENERAL PUBLIC LICENSE", and MPL's file mentions Apache, so the
# wrong-first ordering would classify a copyleft pack as the permissive one.
licence_family() {
  local head
  head="$(head -40 "$1" 2>/dev/null | tr '[:lower:]' '[:upper:]')"
  case "$head" in
    *"GNU LESSER GENERAL PUBLIC"*) echo "LGPL" ;;
    *"GNU AFFERO GENERAL PUBLIC"*) echo "AGPL" ;;
    *"GNU GENERAL PUBLIC"*) echo "GPL" ;;
    *"MOZILLA PUBLIC LICENSE"*) echo "MPL" ;;
    *"APACHE LICENSE"*) echo "APACHE" ;;
    *"CC0"* | *"CC ZERO"* | *"CREATIVE COMMONS ZERO"* | *"PUBLICDOMAIN/ZERO"*) echo "CC0" ;;
    *"REDISTRIBUTION AND USE IN SOURCE"*) echo "BSD" ;;
    *"PERMISSION IS HEREBY GRANTED, FREE OF CHARGE"*) echo "MIT" ;;
    *"MIT LICENSE"*) echo "MIT" ;;
    *) echo "" ;;
  esac
}

[ -d "$ASSET_ROOT" ] || fail "no asset root at ${ASSET_ROOT#"$REPO_ROOT"/}"
[ -f "$SHORTLIST" ] || fail "no shortlist at ${SHORTLIST#"$REPO_ROOT"/}"

shopt -s nullglob
declare -a PACKS=()
for dir in "$ASSET_ROOT"/*/; do
  [ -d "$dir" ] || continue
  PACKS+=("${dir%/}")
done

[ "${#PACKS[@]}" -gt 0 ] || fail 'the asset root is empty, so this check would prove nothing.'

printf 'asset licences: %d pack(s) under %s\n' "${#PACKS[@]}" "${ASSET_ROOT#"$REPO_ROOT"/}"

for pack in "${PACKS[@]}"; do
  name="$(basename "$pack")"

  # RULE 1. A file existing is not verification, but a file ABSENT is an
  # unambiguous failure and this is where it is caught.
  [ -f "${pack}/LICENSE.txt" ] || fail "${name} ships no LICENSE.txt beside the pack."

  # RULE 2. What the shortlist claims, against what is actually shipped.
  claimed="$(grep -E "^\| ${name} \|" "$SHORTLIST" | head -1)" ||
    fail "${name} is shipped but absent from docs/design/asset-shortlist.md. Every pack needs a row."
  [ -n "$claimed" ] ||
    fail "${name} is shipped but absent from docs/design/asset-shortlist.md. Every pack needs a row."

  # The licence cell is the third column; an empty one is the failure the table
  # shape exists to prevent, so it is checked rather than trusted.
  recorded="$(printf '%s' "$claimed" | awk -F'|' '{gsub(/^ +| +$/, "", $4); print $4}')"
  [ -n "$recorded" ] || fail "${name} has an empty licence cell in the shortlist."

  shipped="$(licence_family "${pack}/LICENSE.txt")"
  [ -n "$shipped" ] ||
    fail "${name}'s LICENSE.txt names no licence this script recognises, so the recorded one cannot be verified."

  case "$(printf '%s' "$recorded" | tr '[:lower:]' '[:upper:]')" in
    *"$shipped"*) ;;
    *)
      fail "${name}: the shortlist records '${recorded}' but the shipped LICENSE.txt reads '${shipped}'."
      ;;
  esac
done

# THE ROW COUNT IS A FLOOR THAT IS NOT YET FATAL, and the distinction is
# deliberate rather than convenient.
#
# The licence rules above are per-merge properties with teeth: a pack merged
# without a licence, or with a licence that contradicts the table, is a defect
# that should stop the merge. The count is not — it is the state of a SELECTION
# that has not been made yet, and §14 makes style consistency the actual
# criterion with no script able to judge it.
#
# So it WARNS rather than failing. A gate that is red on a known-incomplete
# selection trains people to ignore it, and the rules above would go with it. The
# floor becomes fatal when the selection lands, and not before: pad the table to
# reach it and the criterion this whole script serves — style, not count — is
# satisfied in form and failed in substance. §14 is explicit that a shortlist of
# 20 packs in five visual styles is worse than 12 in one.
rows="$(grep -E '^\| ' "$SHORTLIST" | grep -vE '^\| *-+ ' | grep -vcE '^\| Pack ' || true)"
if [ "$rows" -lt "$MIN_PACKS" ]; then
  printf 'asset licences: WARNING the shortlist has %d pack(s), under the %d-pack floor.\n' "$rows" "$MIN_PACKS" >&2
  printf '  That is a SELECTION to make, not a number to pad. No script can judge whether the\n' >&2
  printf '  chosen packs look like one game, which is the plan%s actual criterion. The licence\n' "'s" >&2
  printf '  rules above still apply and are enforced; this count does not fail the build yet.\n' >&2
elif [ "$rows" -gt "$MAX_PACKS" ]; then
  printf 'asset licences: WARNING the shortlist has %d packs, over the %d-pack target.\n' "$rows" "$MAX_PACKS" >&2
fi

printf 'asset licences: every pack ships a licence, and it matches the shortlist. %d row(s).\n' "$rows"
