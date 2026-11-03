#!/usr/bin/env bash
# What is waiting for one agent, read from GitHub: its issues, its pull requests (CI and review state),
# and comments that mention it since it last looked. Run at the start of every session and after every push.
# Usage: scripts/inbox.sh <agent-name> [--all]   (--all: mentions from the last 7 days, not just since last time)
# Needs the GitHub CLI (gh), signed in to an account that can read the repository. See AGENTS.md.
set -euo pipefail

name="${1:-}"
if [[ -z "$name" ]]; then
  echo "Usage: scripts/inbox.sh <agent-name> [--all]   e.g. scripts/inbox.sh harsh-t3" >&2
  exit 2
fi
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
state="$(git rev-parse --git-common-dir)/inbox-${name}.since"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "${2:-}" == "--all" || ! -f "$state" ]]; then
  since="$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)"
else
  since="$(cat "$state")"
fi

echo "== Inbox for ${name} (${repo}) =="
echo

echo "-- Your issues (agent:${name}) --"
gh issue list -R "$repo" --label "agent:${name}" --state open --json number,title,labels \
  --jq '.[] | "#\(.number)  [\([.labels[].name | select(startswith("status:"))] | join(", "))]  \(.title)"' | sed 's/^/  /' || true
echo

echo "-- Your pull requests --"
gh pr list -R "$repo" --label "agent:${name}" --state open --json number,title,isDraft,reviewDecision,headRefName,statusCheckRollup \
  --jq '.[] | "#\(.number)  \(if .isDraft then "draft" else "ready" end) · review: \(if (.reviewDecision // "") == "" then "none yet" else (.reviewDecision | ascii_downcase | gsub("_"; " ")) end) · CI: \(
      [.statusCheckRollup[]? | (.conclusion // .status)] | if length == 0 then "not run" elif any(. == "FAILURE") then "RED" elif all(. == "SUCCESS") then "green" else "running" end
    )  \(.title)  (\(.headRefName))"' | sed 's/^/  /' || true
echo

echo "-- Mentions of @${name} since ${since} --"
{
  gh api "repos/${repo}/issues/comments?since=${since}&per_page=100" --paginate \
    --jq ".[] | select((.body | test(\"@${name}\\\\b\")) and ((.body | startswith(\"[${name}]\")) | not)) | \"#\(.issue_url | split(\"/\") | last)  \(.created_at)  \(.body | gsub(\"\\n\"; \" \") | .[0:240])\""
  gh api "repos/${repo}/pulls/comments?since=${since}&per_page=100" --paginate \
    --jq ".[] | select((.body | test(\"@${name}\\\\b\")) and ((.body | startswith(\"[${name}]\")) | not)) | \"PR #\(.pull_request_url | split(\"/\") | last) \(.path):\(.line // .original_line)  \(.body | gsub(\"\\n\"; \" \") | .[0:240])\""
} | sed 's/^/  /' || true
echo

echo "-- Review comments on your open pull requests since ${since} --"
for pr in $(gh pr list -R "$repo" --label "agent:${name}" --state open --json number --jq '.[].number'); do
  gh api "repos/${repo}/pulls/${pr}/reviews" --jq ".[] | select(.submitted_at >= \"${since}\") | \"PR #${pr}  \(.state)  \(.body | gsub(\"\\n\"; \" \") | .[0:240])\"" | sed 's/^/  /' || true
  gh api "repos/${repo}/pulls/${pr}/comments" --jq ".[] | select(.created_at >= \"${since}\") | \"PR #${pr}  \(.path):\(.line // .original_line)  \(.body | gsub(\"\\n\"; \" \") | .[0:240])\"" | sed 's/^/  /' || true
done
echo

echo "-- Ready to take (status: ready, nobody on it) --"
gh issue list -R "$repo" --label "status: ready" --state open --json number,title,labels \
  --jq '.[] | select([.labels[].name | select(startswith("agent:"))] | length == 0) | "#\(.number)  [\([.labels[].name | select(startswith("area:"))] | join(", "))]  \(.title)"' | sed 's/^/  /' || true
echo
echo "-- Areas busy right now (status: in progress) --"
gh issue list -R "$repo" --label "status: in progress" --state open --json number,labels \
  --jq '.[] | "#\(.number)  \([.labels[].name | select(startswith("agent:") or startswith("area:"))] | join(", "))"' | sed 's/^/  /' || true

echo "$now" > "$state"
