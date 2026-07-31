# ADR 0046: Inherited Search Preferences And Model-Scoped Reasoning

Status: Accepted
Amends: 0011-explicit-next-run-control-ownership, 0016-responsive-composer-disclosure, 0030-direct-run-controls-and-reviewed-provider-catalog, 0043-admin-managed-multi-engine-search-plans

## Context

ADR 0043 made the complete ordered Search plan a user-owned next-run value, but
the current browser still reconciles that value destructively on model change:
it removes options unavailable to the target model and saves the reduced plan
back into `UserSettings`. A temporary compatibility fact therefore destroys a
durable user preference. Accepted-run default persistence can repeat the same
loss because it currently receives only the effective run plan.

The Search control plane also has no installation recommendation. Copying an
administrator-selected plan into every user row would be coercive and would
make an intentional empty plan indistinguishable from an untouched default.
The product needs an inherited recommendation that grants no access and yields
permanently to a user's explicit plan, including explicit **Off**.

Reasoning effort and optional mode are already catalog-bounded per-model run
controls and are stored inside the per-model control draft. The complete editor
is nevertheless one More action away even when a wide composer has room, and
the switch/reload contract lacks direct A -> B -> A regression coverage. Values
cannot be mapped safely between OpenAI, Anthropic, Gemini, OpenRouter, or an
administrator-configured compatible gateway merely because their labels look
similar.

## Decision

### Installation recommendation and personal preference

Search owns one versioned installation policy containing an ordered bounded
`SearchPlan`. It is database state managed from Control Center Search, not an
environment value and not a flag on an individual integration. A save uses
optimistic version fencing and accepts only current active, enabled, ready
options whose complete plan/mode is structurally compatible. The policy does
not create or imply a user/group Search grant.

`UserSettings.defaultSearchPlan` becomes nullable:

- `null` means **inherit the installation recommendation**;
- a non-empty plan is the user's explicit personal preference; and
- an empty plan is the user's explicit **Off** preference.

Existing non-null rows remain non-null during migration, including empty plans,
so a release cannot reinterpret a historical Off as consent to a new
recommendation. Newly provisioned users start with `null`. Users can explicitly
return to inheritance through **Use organization default**.

The legacy singleton Search id remains only a bounded compatibility mirror. It
does not decide whether a user inherits and cannot become the owner of a
multi-engine plan.

### Preferred and effective Search plans

The current-user catalog resolves one **preferred plan** from the personal plan
when present, otherwise from the installation recommendation. It exposes only
option identities the user is currently entitled to see; unavailable or
unentitled identities stay stored server-side but are not disclosed. Filtering
never rewrites either the installation policy or personal preference.

The composer keeps that preferred plan as its single Search state and derives
an **effective plan** for the selected model by retaining compatible options and
reconciling orchestration mode. A model change saves the concrete default model
only. It never writes Search preference. Retained selected engines that are not
usable by the current model remain visibly identified as unavailable rather
than being presented as Off or silently deleted. Switching back recomputes the
complete effective plan from the unchanged preference.

Run admission receives and validates only the effective plan. Browser settings
and accepted-run default persistence carry personal preference intent
separately: inherited state is preserved when the user did not edit Search, and
an explicit just-edited preferred plan can commit atomically without being
replaced by the effective subset. Search remains a future-message control and
accepted runs retain their immutable exact effective bindings under ADR 0043.

### Direct model-scoped Reasoning

Reasoning effort and optional mode remain one tuple in the per-model control
draft keyed by the opaque provider connection/deployment selection. Selecting a
profile deliberately writes its exact tuple for its target model; a manual
change makes the derived profile state Custom. Switching models restores each
model's last exact supported tuple. If catalog capabilities later remove a
saved value, the UI uses that model's declared default; it never translates the
value into another provider family's nearest-looking label.

When the composer has wide and sufficiently tall working space, it exposes one
combined direct **Reasoning** trigger with the exact current mode and effort.
The trigger opens one bounded editor for both fields. Narrow or short-height
composition retains Reasoning in the complete More setup. Both presentations
call the existing composer-control actions and share one state owner; there is
no duplicate draft or persistence path. This narrowly amends ADR 0030's rule
that Reasoning is always behind More and restores ADRs 0011/0016 only where the
available composition space supports it.

Mode availability remains catalog and adapter controlled. A provider name,
hostname, or model-looking string never enables `standard | pro`; only an exact
reviewed model configuration whose adapter can serialize the mode may expose
it.

### Presentation direction

The Search policy is a quiet installation control above the existing Search
resource index, not a marketplace card or second grant editor. The composer
continues to read as one Question -> Search -> Answer instrument: Model,
configured Profile, Search, conditional wide Reasoning, and More are peer
future-run controls. Existing semantic `answer-paper`, `control-surface`,
`ink`, `proof`, `caution`, and `critical` tokens retain all color meaning; the
change introduces no decorative palette, gradient, or animation system.

## Rejected Alternatives

- **Copy the admin plan into every user row.** It cannot distinguish untouched
  state from explicit Off and makes later admin changes coercive or stale.
- **Store a complete Search plan per model.** Search-engine preference belongs
  to the user; model compatibility is a derived execution constraint.
- **Persist the model-clamped plan.** This repeats the current data-loss bug.
- **Map reasoning levels across provider families.** Similar labels do not
  establish equal wire behavior, cost, or capability.
- **Add a second desktop Reasoning store/editor.** Two owners recreate the
  control ambiguity removed by ADR 0011.

## Consequences

- Search policy resolution gains a small installation-owned persistence
  boundary and the settings/run contracts distinguish preference from
  execution.
- An administrator can improve first use without granting Search access or
  overriding users who chose differently.
- A model may execute only a subset of the retained preference; the UI must make
  that fact explicit and server admission still rejects stale posted plans.
- Existing users keep current behavior after migration, while new users inherit
  the current recommendation dynamically.
- Wide composition makes the most frequently changed reasoning tuple direct
  without increasing compact composer density.

## Required Verification

- migration, provisioning, bootstrap, and rollback-compatible legacy mirror
  coverage for null inheritance, explicit plans, and explicit Off;
- version-fenced administrator policy validation and proof that it grants no
  entitlement;
- catalog resolution for personal/inherited plans under partial/no access and
  later integration readiness changes without persistence mutation;
- A -> B -> A and reload coverage for multi-engine preference/effective plans,
  orchestration reconciliation, and exact run payload/default persistence;
- A -> B -> A, rapid switch, profile, reload, and stale-capability coverage for
  reasoning mode/effort;
- direct wide Reasoning plus compact/short More-only presentation and retained
  unavailable Search labels without horizontal or viewport overflow; and
- routine static/unit checks plus the Search migration contract and focused
  browser/server workflow.
