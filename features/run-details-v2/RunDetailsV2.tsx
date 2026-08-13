"use client";

import {
  UiV2Button,
  UiV2Chip,
  UiV2Icon,
  UiV2IconButton,
  type UiV2IconName
} from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import type { Catalog } from "@/components/app-shell/types";
import type { PersistedRun } from "@/lib/contracts/runs";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  projectRunDetailsV2,
  runMatchesTargetV2,
  type GeneratedFileRunFactV2,
  type RunDetailsProjectionV2,
  type RunDetailsTargetV2
} from "./runDetailsModel";

type LoadState =
  | Readonly<{ kind: "error"; mismatch: boolean }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; run: PersistedRun }>;

function Section({
  children,
  icon,
  title
}: Readonly<{
  children: ReactNode;
  icon: UiV2IconName;
  title: string;
}>) {
  return (
    <section aria-label={title} className="v2-run-details-section">
      <header className="v2-run-details-section-heading">
        <UiV2Icon name={icon} />
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  );
}

function KeyValues({ rows }: {
  rows: readonly Readonly<{ label: string; value: string }>[];
}) {
  return (
    <dl className="v2-run-details-kv">
      {rows.map((row, index) => (
        <div key={`${row.label}:${index}`}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Timeline({ projection }: { projection: RunDetailsProjectionV2 }) {
  return (
    <Section icon="history" title="Хронология">
      {projection.timeline.length > 0 ? (
        <ol className="v2-run-details-timeline" data-testid="run-details-timeline">
          {projection.timeline.map((item, index) => (
            <li data-tone={item.tone} key={`${item.label}:${index}`}>
              <span aria-hidden="true" className="v2-run-details-timeline-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="v2-run-details-timeline-copy">
                <strong>{item.label}</strong>
                <span>{item.value}</span>
                {item.detail ? (
                  <details>
                    <summary>Записанные детали</summary>
                    <p>{item.detail}</p>
                  </details>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="v2-run-details-empty">
          Этот run записан без событий. Интерфейс не восстанавливает хронологию из текущих настроек.
        </p>
      )}
    </Section>
  );
}

function SearchSection({ projection }: { projection: RunDetailsProjectionV2 }) {
  if (projection.searchAttempts.length === 0) return null;
  return (
    <Section icon="search" title="Search attempts">
      <ol className="v2-run-details-disclosures">
        {projection.searchAttempts.map((attempt, index) => (
          <li key={`${attempt.displayName}:${index}`}>
            <details>
              <summary>
                <span>Попытка {index + 1} · {attempt.displayName}</span>
                <UiV2Chip tone={attempt.status === "error" ? "danger" : "neutral"}>
                  {attempt.status}
                </UiV2Chip>
              </summary>
              <KeyValues rows={[
                { label: "Источники", value: attempt.sourceCount === null ? "Неизвестно" : String(attempt.sourceCount) },
                ...(attempt.query ? [{ label: "Запрос", value: attempt.query }] : []),
                ...(attempt.warning ? [{ label: "Результат", value: attempt.warning }] : [])
              ]} />
            </details>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function ToolSection({ projection }: { projection: RunDetailsProjectionV2 }) {
  if (projection.tools.length === 0) return null;
  return (
    <Section icon="tool" title="Инструменты MCP">
      <ol className="v2-run-details-disclosures">
        {projection.tools.map((tool, index) => (
          <li key={`${tool.serverName}:${tool.toolName}:${index}`}>
            <details>
              <summary>
                <span>{tool.serverName} · {tool.toolName}</span>
                <UiV2Chip tone={tool.status === "Ошибка" ? "danger" : "neutral"}>
                  {tool.status}
                </UiV2Chip>
              </summary>
              <KeyValues rows={[
                { label: "Раунд", value: String(tool.round) },
                ...(tool.durationMs === null ? [] : [{ label: "Время", value: `${tool.durationMs} мс` }]),
                ...(tool.credentialLabel ? [{ label: "Доступ", value: tool.credentialLabel }] : []),
                ...(tool.errorMessage ? [{ label: "Ошибка", value: tool.errorMessage }] : [])
              ]} />
              {tool.argumentsPreview ? (
                <details className="v2-run-details-nested">
                  <summary>Аргументы · redacted</summary>
                  <pre aria-label="Redacted tool arguments" role="region" tabIndex={0}>{tool.argumentsPreview}</pre>
                </details>
              ) : null}
              {tool.resultPreview ? (
                <details className="v2-run-details-nested">
                  <summary>Результат · ненадёжные данные</summary>
                  <pre aria-label="Untrusted tool result preview" role="region" tabIndex={0}>{tool.resultPreview}</pre>
                </details>
              ) : null}
            </details>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function KnowledgeSection({ projection }: { projection: RunDetailsProjectionV2 }) {
  if (projection.knowledge.length === 0) return null;
  return (
    <Section icon="library" title="Knowledge receipts">
      <ol className="v2-run-details-disclosures">
        {projection.knowledge.map((receipt) => (
          <li key={receipt.invocationOrdinal}>
            <details>
              <summary>
                <span>Invocation {receipt.invocationOrdinal} · {receipt.baseNames.join(" + ")}</span>
                <UiV2Chip>{receipt.outcomeLabel}</UiV2Chip>
              </summary>
              <KeyValues rows={[
                { label: "Запрос", value: receipt.query },
                { label: "Кандидаты", value: String(receipt.candidateCount) },
                { label: "Включено", value: String(receipt.includedCount) },
                { label: "Время", value: `${receipt.durationMs} мс` }
              ]} />
              {receipt.results.map((result, index) => (
                <details className="v2-run-details-nested" key={`${result.fileName}:${result.page}:${index}`}>
                  <summary>{result.fileName} · стр. {result.page} · score {result.scoreLabel}</summary>
                  <p className="v2-run-details-exact-text">{result.includedText}</p>
                  {result.truncated ? <small>Превью ограничено сохранённой границей.</small> : null}
                </details>
              ))}
            </details>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function GeneratedFilesSection({ projection }: { projection: RunDetailsProjectionV2 }) {
  if (projection.generatedFiles.length === 0) return null;
  return (
    <Section icon="file" title="Созданные файлы">
      <ul className="v2-run-details-files">
        {projection.generatedFiles.map((file, index) => (
          <li key={`${file.name}:${file.versionLabel}:${index}`}>
            <span><strong>{file.name}</strong><small>{file.format} · {file.versionLabel}</small></span>
            <UiV2Chip tone={file.status === "failed" ? "danger" : "neutral"}>
              {file.status === "ready" ? "Готов" : "Ошибка"}
            </UiV2Chip>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function UsageSection({ projection }: { projection: RunDetailsProjectionV2 }) {
  if (!projection.usage) return null;
  const usage = projection.usage;
  return (
    <Section icon="sliders" title="Usage · provider evidence">
      <KeyValues rows={[
        { label: "Input", value: usage.inputTokens.toLocaleString("ru-RU") },
        { label: "Output", value: usage.outputTokens.toLocaleString("ru-RU") },
        ...(usage.reasoningTokens > 0
          ? [{ label: "Reasoning", value: usage.reasoningTokens.toLocaleString("ru-RU") }]
          : []),
        ...(usage.cachedInputTokens > 0
          ? [{ label: "Cached input", value: usage.cachedInputTokens.toLocaleString("ru-RU") }]
          : []),
        ...(usage.cacheWriteInputTokens > 0
          ? [{ label: "Cache write", value: usage.cacheWriteInputTokens.toLocaleString("ru-RU") }]
          : []),
        { label: "Всего", value: usage.totalTokens.toLocaleString("ru-RU") }
      ]} />
      <p className="v2-run-details-note">Стоимость не показана: сохранённая оценка не является provider-reported billing evidence.</p>
    </Section>
  );
}

function MemorySection({
  onOpenSourceChat,
  projection
}: {
  onOpenSourceChat?(chatId: string): void;
  projection: RunDetailsProjectionV2;
}) {
  const memory = projection.memory;
  if (!memory) return null;
  return (
    <Section icon="memory" title="Память">
      {memory.outcome ? <p className="v2-run-details-memory-outcome">{memory.outcome}</p> : null}
      {memory.degradation ? (
        <p className="v2-run-details-warning">Ограничение: {memory.degradation}</p>
      ) : null}
      {memory.action ? (
        <div className="v2-run-details-memory-action">
          <strong>{memory.action.label}</strong>
          {memory.action.statement ? <p>{memory.action.statement}</p> : null}
        </div>
      ) : null}
      {memory.items.length > 0 ? (
        <ol className="v2-run-details-disclosures">
          {memory.items.map((item, index) => (
            <li key={`${item.itemType}:${index}`}>
              <details>
                <summary>
                  <span>{index + 1}. {item.itemType}</span>
                  <UiV2Chip tone={item.lifecycle === "Источник удалён" ? "warn" : "neutral"}>
                    {item.lifecycle}
                  </UiV2Chip>
                </summary>
                <p className="v2-run-details-exact-text" data-testid="run-memory-frozen-text">
                  {item.includedText}
                </p>
                <KeyValues rows={[
                  { label: "Источник", value: item.sourceMode },
                  { label: "Область", value: item.scope },
                  { label: "Отбор", value: item.selectionReason }
                ]} />
                {item.sourceChatId && onOpenSourceChat ? (
                  <UiV2Button onClick={() => onOpenSourceChat(item.sourceChatId!)}>
                    Открыть источник · {item.sourceMessageCount}
                  </UiV2Button>
                ) : item.lifecycle === "Источник удалён" ? (
                  <p className="v2-run-details-note">Ссылка скрыта: исходный чат удалён.</p>
                ) : null}
              </details>
            </li>
          ))}
        </ol>
      ) : null}
    </Section>
  );
}

function ReadyDetails({
  onOpenMemorySource,
  projection
}: {
  onOpenMemorySource?(chatId: string): void;
  projection: RunDetailsProjectionV2;
}) {
  return (
    <>
      <section aria-label="Run outcome" className="v2-run-details-outcome" data-status={projection.status}>
        <span aria-hidden="true" />
        <strong>{projection.statusLabel}</strong>
        {projection.acceptedAtLabel ? <small>Принят {projection.acceptedAtLabel}</small> : null}
      </section>
      {projection.errorText ? <p className="v2-run-details-error" role="alert">{projection.errorText}</p> : null}
      <Timeline projection={projection} />
      <Section icon="sliders" title="Модель и bindings">
        <KeyValues rows={projection.bindings} />
        {projection.parameters.length > 0 ? (
          <details className="v2-run-details-parameters">
            <summary>Принятые параметры</summary>
            <KeyValues rows={projection.parameters} />
          </details>
        ) : null}
      </Section>
      <SearchSection projection={projection} />
      <ToolSection projection={projection} />
      <KnowledgeSection projection={projection} />
      <GeneratedFilesSection projection={projection} />
      <UsageSection projection={projection} />
      <MemorySection onOpenSourceChat={onOpenMemorySource} projection={projection} />
      {projection.requestPreview ? (
        <Section icon="lock" title="Request preview · redacted">
          <pre
            aria-label="Redacted request preview"
            className="v2-run-details-request-preview"
            role="region"
            tabIndex={0}
          >
            {projection.requestPreview}
          </pre>
        </Section>
      ) : (
        <Section icon="lock" title="Request preview · redacted">
          <p className="v2-run-details-empty">
            Безопасная inspection-проекция недоступна для этого исторического run.
          </p>
        </Section>
      )}
    </>
  );
}

export function ExactRunDetailsDrawerV2({
  cachedRun,
  catalog,
  generatedFiles = [],
  loadRun,
  onClose,
  onOpenMemorySource,
  target
}: Readonly<{
  cachedRun?: PersistedRun | null;
  catalog: Catalog | null;
  generatedFiles?: readonly GeneratedFileRunFactV2[];
  loadRun(runId: string): Promise<PersistedRun | null>;
  onClose(): void;
  onOpenMemorySource?(chatId: string): void;
  target: RunDetailsTargetV2;
}>) {
  const [retryToken, setRetryToken] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const exactCachedRun = cachedRun && runMatchesTargetV2(cachedRun, target)
    ? cachedRun
    : null;
  const {
    dialogRef,
    initialFocusRef: closeRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({ onClose });

  useEffect(() => {
    if (exactCachedRun) return;
    let current = true;
    void loadRun(target.runId).then((run) => {
      if (!current) return;
      if (!run || !runMatchesTargetV2(run, target)) {
        setLoadState({ kind: "error", mismatch: Boolean(run) });
        return;
      }
      setLoadState({ kind: "ready", run });
    }).catch(() => {
      if (current) setLoadState({ kind: "error", mismatch: false });
    });
    return () => {
      current = false;
    };
  }, [exactCachedRun, loadRun, retryToken, target]);

  const effectiveLoadState: LoadState = exactCachedRun
    ? { kind: "ready", run: exactCachedRun }
    : loadState.kind === "ready" && !runMatchesTargetV2(loadState.run, target)
      ? { kind: "loading" }
      : loadState;

  const projection = effectiveLoadState.kind === "ready"
    ? projectRunDetailsV2({ catalog, generatedFiles, run: effectiveLoadState.run, target })
    : null;

  const drawer = (
    <div
      className="v2-run-details-scrim"
      data-testid="run-details-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <aside
        aria-label={`Детали run · ${target.answerLabel}`}
        aria-modal="true"
        className="v2-run-details-drawer"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="v2-run-details-header">
          <span>
            <small>Точный persisted receipt</small>
            <h2>Детали run</h2>
            <span>{target.answerLabel}</span>
          </span>
          <UiV2IconButton
            icon="close"
            label="Закрыть детали run"
            onClick={onClose}
            ref={closeRef}
          />
        </header>
        <div
          aria-busy={effectiveLoadState.kind === "loading" || undefined}
          className="v2-run-details-body"
        >
          {effectiveLoadState.kind === "loading" ? (
            <div className="v2-run-details-state" role="status">
              <span aria-hidden="true" className="v2-spinner" />
              <strong>Загружаю receipt этого ответа…</strong>
              <p>Текущий run или настройки другого ответа не используются.</p>
            </div>
          ) : effectiveLoadState.kind === "error" || !projection ? (
            <div className="v2-run-details-state" role="alert">
              <strong>{effectiveLoadState.kind === "error" && effectiveLoadState.mismatch
                ? "Receipt не принадлежит этому ответу"
                : "Детали run недоступны"}</strong>
              <p>Ответ остаётся без изменений. Можно повторить owner-private чтение.</p>
              <UiV2Button onClick={() => {
                setLoadState({ kind: "loading" });
                setRetryToken((value) => value + 1);
              }}>
                Повторить
              </UiV2Button>
            </div>
          ) : (
            <ReadyDetails onOpenMemorySource={onOpenMemorySource} projection={projection} />
          )}
        </div>
      </aside>
    </div>
  );

  return portalReady ? createPortal(drawer, document.body) : null;
}
