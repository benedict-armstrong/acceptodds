#!/usr/bin/env bash
# Initialise .env.production from .env.production.example.
#
#   scripts/init-env-production.sh [https://public.origin]
#
# Never overrides a value that is already set. A key that is missing is added;
# a key that is present but empty gets a default or a freshly generated secret
# where there is a sensible one, and is otherwise left empty for you to fill.
# Safe to re-run: the second run changes nothing except keys you emptied.
set -euo pipefail

cd "$(dirname "$0")/.."
example=.env.production.example
target=.env.production
app_url=${1:-}

[[ -f $example ]] || { echo "missing $example" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

if [[ ! -f $target ]]; then
  (umask 077 && cp "$example" "$target")
  echo "created $target from $example"
fi
chmod 600 "$target"

# The value of KEY in $target (last assignment wins, like dotenv), or empty.
current() {
  sed -n "s/^[[:space:]]*$1=//p" "$target" | tail -n 1
}

# Hex only, so a secret never needs quoting or URL-escaping.
secret() { openssl rand -hex 32; }

filled=()
# Set KEY to VALUE only if it is missing or empty in $target.
init() {
  local key=$1 value=$2
  [[ -n $(current "$key") || -z $value ]] && return 0
  if grep -q "^[[:space:]]*$key=" "$target"; then
    local tmp
    tmp=$(mktemp "$target.XXXXXX")
    awk -v k="$key" -v v="$value" '
      !done && $0 ~ "^[[:space:]]*" k "=[[:space:]]*$" { print k "=" v; done = 1; next }
      { print }
    ' "$target" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$target"
  else
    printf '%s=%s\n' "$key" "$value" >> "$target"
  fi
  filled+=("$key")
}

# Every key in the example exists in the target, even if still empty.
while IFS= read -r key; do
  grep -q "^[[:space:]]*$key=" "$target" || printf '%s=\n' "$key" >> "$target"
done < <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$example")

# --- database: postgres is the compose service; it publishes no port.
init POSTGRES_USER papermarket
init POSTGRES_DB papermarket
init POSTGRES_PASSWORD "$(secret)"
init DATABASE_URL "postgres://$(current POSTGRES_USER):$(current POSTGRES_PASSWORD)@postgres:5432/$(current POSTGRES_DB)"

# --- app
init NODE_ENV production
init APP_URL "$app_url"
init STARTING_BALANCE_MICRO 1000000000
init API_RATE_LIMIT_BURST 60
init API_RATE_LIMIT_PER_SECOND 2

# --- auth
init BETTER_AUTH_SECRET "$(secret)"
init BETTER_AUTH_URL "$(current APP_URL)"

# --- edge
init RATE_LIMIT_AVERAGE 30
init RATE_LIMIT_BURST 60

if ((${#filled[@]})); then
  echo "filled: ${filled[*]}"
else
  echo "nothing to fill; every key with a default was already set"
fi

# INSTITUTION_DOMAINS_PATH is optional (the image has a default), and so is
# analytics.
empty=()
while IFS= read -r key; do
  [[ $key == INSTITUTION_DOMAINS_PATH || $key == UMAMI_* ]] && continue
  [[ -z $(current "$key") ]] && empty+=("$key")
done < <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$example")
if ((${#empty[@]})); then
  echo "still empty, fill by hand: ${empty[*]}"
fi
