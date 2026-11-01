"""The Workspace's per-site proxy router. Standard library only.

A small forwarder (`_forwarder.py`) listens on loopback inside the VM, only when
the run has proxies: Chromium and `aiqsa-browser proxied` commands point at it,
and it chooses per site by the rules of `selection.py`, adds the upstream's
credentials, or connects directly when nothing applies. `client.py` starts it
and talks to it. Agents reach all of it through `aiqsa-browser`.
"""
