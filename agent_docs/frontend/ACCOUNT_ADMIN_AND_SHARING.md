# FRONTEND ACCOUNT ADMIN AND SHARING

Owner: Account and Control Center UI maintainers
Scope: Non-normative router to bounded authentication, sharing, Control Center, Settings, and Assistant interaction owners.

This file is a routing index, not a functional contract owner. Read the shared boundary/change rules and only the affected feature leaf.

| Read when | Contract owner |
| --- | --- |
| Visual/server ownership boundaries or change rules across account, sharing, administration, Settings, and Assistants | [Boundaries and change rules](account/BOUNDARIES_AND_CHANGE_RULES.md) |
| Login, onboarding, recovery, OAuth continuity, auth mutation states, responsive auth, or public-share viewing | [Auth and public sharing](account/AUTH_AND_PUBLIC_SHARING.md) |
| Control Center navigation, resources, users/groups/invites/usage, providers, Search, MCP, email, safety, or lifecycle UX | [Control Center](account/CONTROL_CENTER.md) |
| Settings, user MCP tools, Assistants, publication, focus, appearance, or project settings | [Settings and Assistants](account/SETTINGS_AND_ASSISTANTS.md) |

Visual composition is routed through [the design system](../DESIGN_SYSTEM.md); server authorization, secrets, and transactional outcomes through [backend API and auth](../backend/API_AND_AUTH.md) and [security](../SECURITY.md).
