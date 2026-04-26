#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "=== Eligible voter snapshot ==="
curl -s "$BASE_URL/api/state" -H "x-name: Alice Thornton" | jq '.voting'

echo
echo "=== Candidate snapshot ==="
curl -s "$BASE_URL/api/state" -H "x-name: Dario Espinoza" | jq '.voting'