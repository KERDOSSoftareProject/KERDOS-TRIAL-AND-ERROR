#!/usr/bin/env bash
# HTTP authentication smoke checks only. Import, recovery dispatch/scheduling,
# database races and browser preview/Save require separate evidence.
set -euo pipefail
exec python3 "$(dirname "$0")/check_a1_deployed_auth.py" "$@"
