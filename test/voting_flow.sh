#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_NAME="${ADMIN_NAME:-Admin User}"

echo "=== Register admin ==="
curl -s -X POST "$BASE_URL/api/join" \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin User","role":"competitor","password":"admin"}' | jq '{name: .participant.name, isAdmin: .participant.isAdmin}'

echo
echo "=== Lock draw ==="
curl -s -X POST "$BASE_URL/api/admin/lock-draw" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '.groups | map({id, status, members})'

echo
echo "=== Set speaker to activate a group ==="
SPEAKER="$(curl -s "$BASE_URL/api/state" -H "x-name: $ADMIN_NAME" | jq -r '.groups[0].members[0]')"
curl -s -X POST "$BASE_URL/api/admin/timer" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"set-speaker\",\"speakerName\":\"$SPEAKER\",\"groupId\":0}" | jq '{ok, currentSpeaker}'

echo
echo "=== Mark remaining speakers as spoken ==="
curl -s -X POST "$BASE_URL/api/admin/advance" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d '{"action":"next-speaker"}' >/dev/null
SECOND="$(curl -s "$BASE_URL/api/state" -H "x-name: $ADMIN_NAME" | jq -r '.groups[0].members[1]')"
curl -s -X POST "$BASE_URL/api/admin/timer" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"set-speaker\",\"speakerName\":\"$SECOND\",\"groupId\":0}" >/dev/null
curl -s -X POST "$BASE_URL/api/admin/advance" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d '{"action":"next-speaker"}' >/dev/null
THIRD="$(curl -s "$BASE_URL/api/state" -H "x-name: $ADMIN_NAME" | jq -r '.groups[0].members[2]')"
curl -s -X POST "$BASE_URL/api/admin/timer" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"set-speaker\",\"speakerName\":\"$THIRD\",\"groupId\":0}" >/dev/null
curl -s -X POST "$BASE_URL/api/admin/advance" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d '{"action":"next-speaker"}' >/dev/null

echo
echo "=== Open voting ==="
GROUP_MEMBERS="$(curl -s "$BASE_URL/api/state" -H "x-name: $ADMIN_NAME" | jq -c '.groups[0].members')"
curl -s -X POST "$BASE_URL/api/admin/open-voting" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"candidates\":$GROUP_MEMBERS,\"windowSeconds\":30}" | jq '.'

echo
echo "=== Voting snapshot ==="
curl -s "$BASE_URL/api/state" -H "x-name: Alice Thornton" | jq '.voting | {active, candidates, eligible_count: (.eligibleVoters | length)}'

echo
echo "=== Cast vote ==="
curl -s -X POST "$BASE_URL/api/vote" \
  -H "x-name: Alice Thornton" \
  -H "Content-Type: application/json" \
  -d '{"voterName":"Alice Thornton","candidateName":"Dario Espinoza"}' | jq '.'

echo
echo "=== Close voting ==="
curl -s -X POST "$BASE_URL/api/admin/close-voting" \
  -H "x-name: $ADMIN_NAME" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '.results'