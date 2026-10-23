#!/usr/bin/env bash
# Fail the build if a real credential ever reaches a tracked file.
# Run before every commit. Exit 0 = clean.
set -uo pipefail

# Exclude the ignore rules' own territory and VCS metadata.
TARGETS=(. --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=data
         --exclude=.env --exclude-dir=.cache)

PATTERNS=(
  'AstraCS:[A-Za-z0-9]{6,}'                     # Astra DB application token
  'AIza[A-Za-z0-9_-]{20,}'                      # Google / Gemini API key
  'sk-[A-Za-z0-9]{20,}'                         # OpenAI-style key
  'ghp_[A-Za-z0-9]{20,}'                        # GitHub PAT
  'AKIA[0-9A-Z]{16}'                            # AWS access key id
)

status=0
for pat in "${PATTERNS[@]}"; do
  # --exclude-dir=.git etc. must be re-passed per invocation for grep -r
  if out=$(grep -rInE "$pat" "${TARGETS[@]}" 2>/dev/null); then
    echo "SECRET LEAK in pattern: $pat"
    echo "$out" | head -10
    status=1
  fi
done

# Also flag any tracked .env file outright.
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "SECRET LEAK: .env is tracked by git"; status=1
fi

if [ "$status" -eq 0 ]; then
  echo "secret scan: clean"
else
  echo "secret scan: FAILED"
fi
exit "$status"