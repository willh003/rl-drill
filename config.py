"""Per-install configuration.

Everything that names *your* machine or *your* GitHub account lives in
config.json beside this file (copy config.example.json and fill it in).
The code carries no account names, no absolute paths and no keys.

Missing config is not an error: the desktop drill runs entirely locally
without it. Sync, deploy and notifications each check for the piece of
config they need and quietly sit out when it is absent.
"""

import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(HERE, "config.json")


def _load():
    try:
        with open(CONFIG_FILE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


_CFG = _load()

# The private repo that state.json, cards.json and review history sync
# through. Empty means "no sync": the drill is local-only.
SYNC_REPO = _CFG.get("syncRepo", "")

# Where the phone app is served from; opened when a push notification is
# tapped. Empty is fine if you never enable notifications.
APP_URL = _CFG.get("appUrl", "")

# The public GitHub Pages repo the webapp deploys to.
PAGES_REPO = _CFG.get("pagesRepo", "")

# VAPID contact (RFC 8292 `sub` claim) -- a mailto: URL the push service
# can reach you at. Required before notifications can be sent.
CONTACT = _CFG.get("contact", "")


def tool(name, *fallback_dirs):
    """Absolute path to a CLI tool.

    launchd jobs run with a bare PATH that misses Homebrew, so a plain
    `which` is not enough: check PATH first, then the usual install
    locations. config.json can pin an exact path under the tool's name.
    """
    pinned = _CFG.get(name, "")
    if pinned:
        return pinned
    found = shutil.which(name)
    if found:
        return found
    for d in fallback_dirs + ("/opt/homebrew/bin", "/usr/local/bin"):
        candidate = os.path.join(d, name)
        if os.path.exists(candidate):
            return candidate
    return name  # let subprocess fail with a legible "not found"


GH = tool("gh")
NODE = tool("node")
