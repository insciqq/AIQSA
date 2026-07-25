# AIQSA product-grounded revamp mockups v1

Generated on 2026-07-25 with `gpt-image-2` after checking the current UI code, `FRONTEND.md`, `PROVIDER_API_NOTES.md`, ADR 0022, and ADR 0024. This set preserves the visual direction of the earlier concepts while replacing invented navigation and capabilities with AIQSA's actual product surface.

## Source-of-truth boundary

These are design mockups, not screenshots of shipped UI. Existing capabilities and proposed presentation/orchestration are deliberately separated:

| Screen | Existing AIQSA capability represented | Proposed revamp behavior |
|---|---|---|
| `01-chat-active-events-desktop.png` | chat/folder rail, assistant document flow, citations, search/tool/reasoning disclosures, Fast/Balanced/Deep, Model, Reasoning, Search, Run settings, Branch/Events detail | calmer visual composition |
| `02-...-refined.png` | valid no-entitled-model state and disabled composer | admin-aware `Connect provider` CTA |
| `03-personal-provider-quick-setup-desktop.png` | OpenAI/Anthropic/OpenRouter/OpenAI-compatible provider families and write-only credentials | Personal disclosure plus atomic `Test & Save` |
| `04-...-refined.png` | credential/model/profile/access concepts | one successful Quick setup outcome without a group step |
| `05-...-refined.png` | the same provider controls on a narrow viewport | touch-first Quick setup flow |
| `06-team-users-desktop.png` | Users, statuses, roles, groups, effective access, session/account actions | redesigned Team list/detail composition |
| `07-...-refined-v4.png` | group provider/model/search/MCP grants | redesigned Team Model access matrix with real search strategies |
| `08-...-refined.png` | Connections, Run profiles, Connection, Credentials, Key assignment, Models, Diagnostics and troubleshooting | progressive Advanced provider workspace |

`Test & Save`, deterministic recommended-model selection, atomic activation/defaults, a direct model grant for the acting admin, the Personal/Team disclosure rule, and the no-model admin CTA are proposals. They require a new server-side Quick setup endpoint and contract tests before implementation. They are not represented as already shipped behavior.

## Real global admin destinations

The preferred mockups use only the current destinations:

- Providers;
- Users;
- Groups;
- Model access;
- Invites;
- Access rules;
- Email delivery;
- MCP servers;
- Usage;
- Safety.

`Run profiles` is provider-local. Personal, Team & access, Advanced infrastructure, Operations, and Security are disclosure/navigation groups, not plans, licenses, or new resources.

There is intentionally no global Overview, Models, Tools, Delivery, Activity, Audit, Evaluations, Datasets, Policies, Monitoring, Governance, or admin Settings destination. Provider detail likewise has no revision history, rollback, Activity, or provider-specific audit subsystem.

## Review order

1. `02-chat-no-model-admin-desktop-refined.png`
2. `03-personal-provider-quick-setup-desktop.png`
3. `04-personal-provider-success-desktop-refined.png`
4. `01-chat-active-events-desktop.png`

Review Team and Advanced separately:

1. `06-team-users-desktop.png`
2. `07-team-model-access-desktop-refined-v4.png`
3. `08-provider-advanced-desktop-refined.png`

The original and intermediate raster generations remain beside the preferred files. They are retained as visual evidence of the refinement process and must not be treated as the current recommendation when they contain invented labels. Exact prompts, including targeted refinement prompts, are in `prompts/`.

## Rendering note

Raster mockups can contain minor typographic or icon inconsistencies. Product labels, capability boundaries, and implementation contracts are owned by `REVAMP.md` and the repository documentation/code, not inferred from pixels.
