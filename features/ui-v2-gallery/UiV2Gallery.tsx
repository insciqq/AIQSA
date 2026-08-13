"use client";

import {
  UiV2Button,
  UiV2Chip,
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuItem,
  UiV2MenuSurface,
  UiV2Skeleton,
  UiV2Toast
} from "@/components/ui-v2";

export function UiV2Gallery() {
  return (
    <main
      className="min-h-dvh bg-[var(--v2-color-canvas)] px-4 py-8 font-sans text-[var(--v2-color-text)] sm:px-8"
      data-testid="ui-v2-control-gallery"
    >
      <UiV2IconSprite />
      <div className="mx-auto grid w-full max-w-[60rem] gap-8">
        <header className="border-b border-[var(--v2-color-border)] pb-5">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.07em] text-[var(--v2-color-text3)]">
            Reading Room · control inventory
          </p>
          <h1 className="mt-2 text-[1.625rem] font-semibold leading-[1.3]">
            UI foundations
          </h1>
          <p className="mt-2 max-w-[46.25rem] text-sm leading-[1.5] text-[var(--v2-color-text2)]">
            Semantic controls share one quiet hierarchy in dark and light. Status color
            appears only when a real status exists.
          </p>
        </header>

        <section aria-labelledby="buttons-heading">
          <h2 className="text-sm font-semibold" id="buttons-heading">Buttons and focus</h2>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <UiV2Button tone="primary" icon="arrow-up">Send</UiV2Button>
            <UiV2Button tone="ghost">Ghost</UiV2Button>
            <UiV2Button tone="destructive">Destructive</UiV2Button>
            <UiV2Button tone="primary" disabled>Disabled</UiV2Button>
            <UiV2Button tone="ghost" busy>Checking</UiV2Button>
            <UiV2IconButton icon="plus" label="Add capability" />
            <UiV2IconButton icon="stop" label="Stop run" round />
          </div>
        </section>

        <section className="grid gap-5 md:grid-cols-2" aria-label="Menu and compact states">
          <div>
            <h2 className="text-sm font-semibold">Menu states</h2>
            <UiV2MenuSurface className="mt-3" label="Model choice">
              <UiV2MenuItem>Gpt 5.2</UiV2MenuItem>
              <UiV2MenuItem selected>Claude Sonnet 4.5</UiV2MenuItem>
              <UiV2MenuItem disabled sub="Not available to this account">
                Gemini 2.5 Pro
              </UiV2MenuItem>
            </UiV2MenuSurface>
          </div>

          <div>
            <h2 className="text-sm font-semibold">Chips and status</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <UiV2Chip><UiV2Icon name="attach" /> budget.csv · Processing</UiV2Chip>
              <UiV2Chip tone="ok">sales_q3.csv · Ready</UiV2Chip>
              <UiV2Chip tone="warn">scan.pdf · Retry</UiV2Chip>
              <UiV2Chip tone="danger">setup.exe · Unsupported</UiV2Chip>
            </div>
            <div className="mt-5 grid gap-2" aria-label="Loading skeleton">
              <UiV2Skeleton className="block w-4/5" />
              <UiV2Skeleton className="block w-3/5" />
              <UiV2Skeleton className="block w-2/3" />
            </div>
          </div>
        </section>

        <section aria-labelledby="toast-heading">
          <h2 className="text-sm font-semibold" id="toast-heading">Ephemeral result</h2>
          <div className="mt-3">
            <UiV2Toast action="Undo">Chat moved to archive</UiV2Toast>
          </div>
        </section>

        <p className="border-t border-[var(--v2-color-border)] pt-5 text-[0.75rem] leading-[1.45] text-[var(--v2-color-text3)]">
          Fixture route only. It carries no account, provider, chat, or Memory data.
        </p>
      </div>
    </main>
  );
}
