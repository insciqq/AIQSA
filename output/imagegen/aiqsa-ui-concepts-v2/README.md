# AIQSA generated UI concepts v2

Generated with the `imagegen` CLI fallback and `gpt-image-2`. These raster concepts supplement the preserved code-rendered concepts in `.aiqsa/ui-revamp/concept/`; they do not replace them and are not implementation assets.

## Preferred review sequence

1. `01-research-chat-desktop.png` — clean-slate Research Chat and contextual evidence drawer.
2. `02-providers-quick-entry-desktop.png` — Providers index and immediate key-entry path.
3. `03b-provider-quick-setup-desktop-refined.png` — preferred desktop Quick setup with the corrected Control Center navigation.
4. `04-provider-quick-setup-mobile.png` — dedicated mobile task view.
5. `06-provider-quick-success-desktop.png` — truthful ready state after orchestration.
6. `05-provider-advanced-desktop.png` — expert controls after setup.

`03-provider-quick-setup-desktop.png` is the retained first generation. Its main form is useful, but its left navigation contains invented sections; the `03b` refinement is the preferred direction.

## Product contract visualized

For OpenAI, Anthropic, OpenRouter, and other known providers:

```text
Choose provider -> paste API key -> Test & Save -> ready
```

Custom endpoints, protocols, credential policy, model/capability overrides, routing, paid diagnostics, and audit/version controls remain under Advanced configuration.

The complete batch prompt set is in `prompts.jsonl`; the targeted refinement prompt is in `03b-refinement-prompt.txt`.
