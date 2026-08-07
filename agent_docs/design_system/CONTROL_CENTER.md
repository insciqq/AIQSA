# DESIGN SYSTEM — CONTROL CENTER

Owner: Frontend visual-system maintainers
Scope: Control Center visual hierarchy, provider workspace composition, resource tables, dialogs, and lifecycle surfaces.
Read when: Changing Control Center layout, providers workspace, Quick setup presentation, resource tables, lifecycle operations, or admin density.
Code owners: Control Center and administrator surface components under `components/admin/`.
Not owned here: Functional admin authorization, Chat composition, global tokens, or interaction-state recipes.

## Control Center Composition

The Control Center is an operational workspace, not a dashboard landing page.
[Control Center behavior](../frontend/account/CONTROL_CENTER.md) owns the
destination set, order, canonical IDs, and initial route. This visual system
groups those destinations under stable visible subject headings used only for
orientation — never as plans, modes, roles, routes, collapsible stages, or
status classifiers.

The active destination owns the page title, short scope description, primary action, status/feedback, and content. Do not repeat a global metric-card strip above every task. Important counts belong beside the relevant navigation item or section heading.

### Providers workspace and Quick setup

The provider tasks supplied by the functional owner render as one persistent
flat peer line with underline/current-text treatment, never filled pills or a
second navigation rail. Its narrow/zoom fallback remains touch- and
focus-scrollable without visible scrollbar chrome; visual labels never require
eager counts.

Quick setup visualizes the functional owner's provider choice, credential,
primary commit, working state, and factual result as one focused low-noise
surface. Equal provider choices use two compact columns, three intermediate
columns, and one wide row. Credential/model input and the primary action stay in
one vertical scan; optional guidance and existing configuration are quiet
context, never a competing `Advanced` gate. Only observed lifecycle state may
receive a label or motion, and a contextual management handoff never competes
with the primary setup action.

Custom OpenAI-compatible setup is not a branded imitation or an Advanced gate.
Its Back-connected task uses the same restrained geometry and one primary
vertical scan supplied by the functional owner. Discovered selections render as
quiet ordered rows with local removal and bounded secondary bulk actions, not
chips, a checkbox wall, or a second catalog panel. Optional protocol/tool
configuration stays in one quiet disclosure, factual readiness uses document
hierarchy with proof accent, and the saved-model editor reuses the same picker
geometry rather than an unrelated native control.

Never imply that a successful catalog check guarantees future generation or billing. Ready presentation names only factual installed/default effects. [Control Center behavior](../frontend/account/CONTROL_CENTER.md), [provider admission](../backend/providers/ADMISSION_AND_BINDINGS.md), and the [administrator API](../backend/api/ADMIN_CONTROL_PLANE.md) own replacement, assignment removal, atomicity, and secret-lifecycle behavior.

### Resource and lifecycle work

Directory/detail resources supplied by the functional owner use a full-width
index whose complete row is the selection target, followed by a Back-connected
detail task. Detail actions form compact wrapping groups; disabled commits stay
neutral and become solid proof only for actionable drafts. Peer resource tasks
use the shared flat task treatment. Built-in resources retain the same
row/detail composition with one quiet marker and factual state, never a
promotional card, warning, or matrix of disabled toggles. A persistent desktop
master/detail split is not the default composition.

Provider, MCP, and email lifecycle controls use progressive disclosure with
observed state beside the advancing action. Working stages use proof/neutral
progress, ready uses positive, and only a terminal safe failure uses critical;
percent and ETA are never invented. Index/detail tasks use a full-width index,
horizontal peer tasks, and one lightly tinted task canvas around bounded divided
rows, without a second vertical rail or clipped menus. Unconfigured and disabled
facts remain neutral. Concrete first-activation blockers may use one bounded
critical-tint callout while their corrective action stays proof-colored rather
than destructive.

MCP import uses one large configuration-document surface rather than a generic single-line field or fake IDE: a bounded viewport-responsive mono editing plane on `composer-surface`, a slim proof scan edge, quiet identity/format chrome, and an attached trust/primary-action strip. The surface owns its rounded boundary and semantic focus/error ring; focus and error color changes settle in roughly 150ms without entrance or layout motion. Short-height viewports reduce the initial editing height while retaining local resize/scroll and reachable actions. Do not duplicate pasted content into a syntax-highlight mirror, inherit ordinary control height, add decorative editor chrome, or introduce a code-editor dependency for this paste-and-review step.

Availability is a first-class binary resource fact across the Control Center and ordinary-user Settings. Render one compact dot-and-label status at the scan point: `Enabled` uses the positive token; `Disabled` uses a bounded high-contrast neutral surface/text combination and never `ink-muted`, `ink-disabled`, caution, or critical. Status and action are always separate elements. Use a soft proof-colored **Enable** button for restoration while the corresponding **Disable** action stays quiet; when setup or authorization is the truthful prerequisite, that action remains accented without hiding the separate Disabled status. Keep solid proof buttons for the local primary decision such as Test & Save, Save, or Activate. Do not apply this binary style to publication, readiness, grants, approvals, invitations, archives, selections, or unavailable form controls.

In dense resource inventories, availability also owns one restrained leading scan edge and surface wash: positive for Enabled and strong neutral for Disabled, never opacity or error color. Selection composes as an independent ring/background and does not erase the resource state. User accounts preserve their four-state language (`Active`, `Disabled`, `Pending`, `Denied`): Active/Disabled share the availability geometry and scan strength, while Pending/Denied retain caution/critical lifecycle semantics. Dependency readiness such as an Assistant's unavailable required access remains a separately labeled fact beside the persisted resource state.

At compact widths, list and detail are separate compositions with an explicit Back action; a shared Control Center resource workspace retains its split only when its own inline size reaches 64rem. [Control Center behavior](../frontend/account/CONTROL_CENTER.md) owns preserved query, scroll, selection, and focus state. Tables may own local horizontal scrolling for comparison data, but a primary workflow must not require dragging a desktop table sideways to reach its action.

The Assistant editor keeps draft/invalid state beside its field owner, one
primary commit, and a quiet cancel action. Card actions supplied by the
functional owner use one primary action plus a quiet overflow menu; destructive
intent remains disclosed rather than resting. [Control Center behavior](../frontend/account/CONTROL_CENTER.md) owns exact actions,
dirty-navigation guards, pending mutations, and reconciliation.
