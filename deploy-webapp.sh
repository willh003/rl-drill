#!/bin/sh
# Publish webapp/ to your public GitHub Pages repo, generating the app's
# config.json on the way out. Run from the drill directory:
#
#   sh deploy-webapp.sh
#
# Needs: config.json (pagesRepo + syncRepo filled in), an authenticated
# `gh`, and -- if you want notifications -- .vapid.json from gen-vapid.js.
# The deployed config.json is generated here and never committed to the
# source repo, so the source stays free of account names and keys.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

cfg() { /usr/bin/python3 -c "
import json,sys
try: print(json.load(open('$DIR/config.json')).get('$1',''))
except Exception: print('')
"; }

PAGES_REPO="$(cfg pagesRepo)"
SYNC_REPO="$(cfg syncRepo)"
[ -n "$PAGES_REPO" ] || { echo "set pagesRepo in config.json first"; exit 1; }
[ -n "$SYNC_REPO" ]  || { echo "set syncRepo in config.json first"; exit 1; }

VAPID_PUB=""
if [ -f "$DIR/.vapid.json" ]; then
  VAPID_PUB="$(/usr/bin/python3 -c "
import json; print(json.load(open('$DIR/.vapid.json'))['publicKeyB64u'])")"
else
  echo "note: no .vapid.json -- deploying without a push key" >&2
  echo "      (run 'node gen-vapid.js' and redeploy to enable notifications)" >&2
fi

# The app's runtime config: which private repo progress lives in, and the
# public half of the push keypair.
/usr/bin/python3 - "$SYNC_REPO" "$VAPID_PUB" > "$DIR/webapp/config.json" <<'EOF'
import json, sys
owner, repo = sys.argv[1].split("/", 1)
print(json.dumps({"owner": owner, "repo": repo,
                  "vapidPublicKey": sys.argv[2]}, indent=1))
EOF

# Push the whole webapp/ directory as one commit, via a scratch clone --
# not per-file contents-API calls, which is how deployed copies drift.
TMP="$(mktemp -d -t rl-pages)"
trap 'rm -rf "$TMP"' EXIT
gh repo clone "$PAGES_REPO" "$TMP" -- --depth 1
find "$TMP" -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +
cp -R "$DIR/webapp/." "$TMP/"
cd "$TMP"
git add -A
if git diff --cached --quiet; then
  echo "already up to date -- nothing to deploy"
else
  git commit -q -m "deploy webapp"
  git push -q
  echo "deployed webapp/ to $PAGES_REPO"
fi
