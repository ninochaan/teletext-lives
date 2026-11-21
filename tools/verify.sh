#!/bin/bash
# TELETEXT LIVES — per-file check run by the verify-on-save Kiro hook
# (.kiro/hooks/verify-on-save.json) whenever the agent saves app.js or
# styles.css. Fast and offline on purpose: this catches a broken save
# inside the session. The full browser verification lives in the
# verify-before-done checklist (.kiro/hooks/verify-before-done.json),
# not here.
set -u
f="${1:-}"
case "$f" in
  *.js)
    node --check "$f" && echo "verify: $f - JS syntax OK"
    ;;
  *.css)
    python3 - "$f" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)  # ignore braces in comments
depth = 0
for ch in src:
    if ch == "{":
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth < 0:
            print("verify: %s - CSS braces unbalanced (extra '}')" % sys.argv[1])
            sys.exit(1)
if depth != 0:
    print("verify: %s - CSS braces unbalanced (%d unclosed)" % (sys.argv[1], depth))
    sys.exit(1)
print("verify: %s - CSS braces balanced" % sys.argv[1])
PY
    ;;
  *)
    echo "verify: no check defined for $f - skipped"
    ;;
esac
