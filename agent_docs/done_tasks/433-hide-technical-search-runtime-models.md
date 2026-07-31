# 433-hide-technical-search-runtime-models

Status: done
Completed: 2026-07-31
Depends on: none

## Goal

Keep technical Search runtime models out of answer-model selection and admission.

## Scope

- Add an explicit provider-neutral answer-selection property to immutable
  provider-model configuration, defaulting legacy and ordinary models to
  selectable.
- Keep non-answer-selectable models available to the Provider and Search
  control planes, credential checks, exact Search revisions, and technical
  Search admission while excluding them from current-user answer catalogs,
  defaults/profiles, access-model choices, and direct answer admission.
- Expose the property in the existing administrator model editor with clear
  technical-runtime language and preserve draft/test/activate fencing.
- Publish and deploy the verified release to the operator-selected production
  installation, mark its dedicated Search runtime models technical-only, and
  run sanitized API/browser/Search smoke.

## Out Of Scope

- Unrelated product changes.
- Inferring model role from a display name, provider, hostname, upstream model
  id, or whether a Search integration happens to be enabled.
- Preventing one answer-selectable model from also serving as a Search runtime.
- Changing Search integration enablement, entitlement, or evidence behavior.

## Acceptance Criteria

- A technical-only provider model never appears in Research Chat's model
  selector or any other answer-model catalog projection and is rejected when
  posted directly as an answer model.
- The same model remains available to Admin Search and can execute through an
  accepted provider-model Search revision without answer-model entitlement.
- Existing model configurations remain answer-selectable by default; an
  administrator can change the property through the normal tested activation
  lifecycle without exposing provider credentials.
- Focused/full checks pass, durable contracts are updated, and production
  smoke proves disabled and enabled Search integrations no longer leak their
  dedicated technical models into answer selection.

## Tests

- Provider-configuration normalization, catalog/default/profile filtering,
  answer-vs-technical admission, admin model editor, and browser picker tests.
- docker compose -f docker-compose.dev.yml exec -T app npm run check.
- Release privacy/image checks plus sanitized authenticated production smoke.

## Done Notes

- Added the backward-compatible immutable `answerSelectable` provider-model
  property. Legacy, Quick, and Custom answer deployments normalize to `true`;
  administrators may set `false` through the existing provider draft, exact
  test, and activation lifecycle.
- Technical-only models remain available to Admin Providers, Admin Search,
  credential resolution, immutable Search bindings, and technical admission,
  while current-user answer catalogs/defaults, grant choices, Run-profile
  targets, and atomic answer admission exclude them. Full access does not
  override the role, and no provider/name/hostname/Search-state inference was
  introduced.
- Accepted ADR 0044 and updated the owning architecture, backend, frontend,
  pipeline, invariant, and testing contracts.
- Verification: `docker compose -f docker-compose.dev.yml exec -T app npm run
  check` passed with 324 files / 2,713 tests passed and 14 tests skipped; the
  focused Chromium provider lifecycle scenario passed; `docs:check`, release
  image build, non-root/runtime checks, diff check, and public privacy review
  passed.
- Published `v0.1.10` from commit
  `5ddb73278c4cd1172a19778562bc10f0bcb502e3`; GitHub Action `30622310329`
  published both `linux/amd64` and `linux/arm64` at immutable digest
  `sha256:b1734a79eb19304a6c213d768329185340137bec9b709e811b5dd3bb76a6a25e`.
- Guarded deployment updated only the operator-selected installation, created
  and verified the pre-migration backup, completed migrations/bootstrap, passed
  readiness and the 30-second observation, and left zero active model runs.
- Both existing dedicated Search runtimes passed exact tiny-generation tests
  and were activated as revision 2 with `answerSelectable=false`. Production
  API smoke found zero technical models in the answer catalog, direct stale
  admission returned `model_not_available`, and the enabled Sol technical
  Search smoke remained ready/available with normalized source evidence.
- Authenticated Chromium at `1440x500` found zero technical runtime labels in
  the model picker, showed enabled Sol Search for the compatible ordinary Sol
  answer deployment, kept disabled GPT-5.5 Search hidden, and found no overflow
  or browser errors. The stale technical default is deliberately not leaked or
  silently rewritten.
