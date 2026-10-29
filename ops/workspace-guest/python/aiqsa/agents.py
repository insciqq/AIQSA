"""Which agent of a chat a Workspace command belongs to, and the browser's per-agent protocol. Constants only.

One Workspace serves every agent of a chat: the main agent and its sub-agents act for the same user in the same VM
and share one browser. AIQSA sets ``AIQSA_AGENT_ID`` in the environment of every command it runs for an agent:
``main`` for the main agent, the sub-agent's thread id otherwise, and ``AIQSA_AGENT_NAME`` to a sub-agent's name for
step lines and the live panel. Python helpers read the same variables. The id is a coordination key, not a security
boundary: any code in the VM can set it, and the VM is the user's own sandbox.

The browser keeps tabs, a current tab and a slot per agent, at most ``BROWSER_AGENT_SLOTS`` agents at once. The live
hub streams one agent's tab at a time: the host lists the browsing agents (``LIVE_AGENTS_MESSAGE``), a view picks
whose tab it streams (``LIVE_SELECT_MESSAGE``), and the ``control``, ``handoff`` and ``input`` messages name their
agent in ``LIVE_AGENT_FIELD`` (absent: the main agent, as protocol 1 had it).

``lib/server/subagents/guestProtocol.ts`` mirrors every constant here and a test keeps the two equal; change both.
"""

#: The agent a command runs for: ``MAIN_AGENT_ID`` or a sub-agent's thread id (``AGENT_ID_PATTERN``).
AGENT_ID_ENV = "AIQSA_AGENT_ID"
#: A sub-agent's name (a lowercase slug), for step lines such as ``[browser #3 · amazon]``; unset for the main agent.
AGENT_NAME_ENV = "AIQSA_AGENT_NAME"
MAIN_AGENT_ID = "main"
#: Letters, digits, ``_`` and ``-``: the main agent's id or a thread id.
AGENT_ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$"
AGENT_NAME_MAX_CHARS = 48

#: Agents that hold a browser slot at once (operator decision 2026-10-29). How long a sixth waits, when an idle slot
#: is released and how many tabs one agent keeps are the browser helper's own settings, not part of this protocol.
BROWSER_AGENT_SLOTS = 5
#: A sixth agent's first page action, after a bounded wait for a slot.
BROWSER_BUSY_CODE = "browser_busy"
#: A new tab that would push the VM past a safe memory line.
BROWSER_MEMORY_LOW_CODE = "browser_memory_low"
#: ``aiqsa-browser release``: the agent gives its slot back; AIQSA sends the same when the agent's call or run ends.
BROWSER_RELEASE_COMMAND = "release"

#: The live protocol version that understands per-agent messages.
LIVE_PER_AGENT_PROTOCOL = 2
#: The field naming the agent of a message (both directions).
LIVE_AGENT_FIELD = "agent"
#: Host to view: ``{"t": "agents", "agents": [{"agent": id, "name": ..., "page": ..., "controller": ..., "handoff": ...}]}``.
LIVE_AGENTS_MESSAGE = "agents"
#: The list field of ``LIVE_AGENTS_MESSAGE``.
LIVE_AGENTS_FIELD = "agents"
#: View to host: ``{"t": "select", "agent": id}``, the agent whose current tab the view streams.
LIVE_SELECT_MESSAGE = "select"
