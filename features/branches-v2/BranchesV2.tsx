"use client";

import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2Skeleton
} from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";
import {
  useId,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import {
  branchPagerForMessageV2,
  branchVersionsV2,
  type BranchPagerStateV2,
  type BranchVersionV2
} from "./branchModel";

export function EditBranchStripV2({
  error = null,
  onCancel,
  pending = false
}: Readonly<{
  error?: string | null;
  onCancel(): void;
  pending?: boolean;
}>) {
  return (
    <section className="v2-edit-branch-strip" data-testid="edit-branch-strip-v2">
      <UiV2Icon name="branch" />
      <span>
        <strong>{pending ? "Сохраняем новую ветвь…" : "Редактирование сообщения"}</strong>
        <small>Отправка создаст новую ветвь; история не изменится.</small>
        {error ? <small className="v2-edit-branch-error" role="alert">{error}</small> : null}
      </span>
      <button
        aria-label="Отменить редактирование"
        disabled={pending}
        onClick={onCancel}
        title={pending ? "Дождитесь сохранения новой ветви" : "Отменить редактирование"}
        type="button"
      >
        Отмена
      </button>
    </section>
  );
}

export function BranchPagerV2({
  disabledReason = null,
  onCheckout,
  pending = false,
  state
}: Readonly<{
  disabledReason?: string | null;
  onCheckout(leafId: string): void;
  pending?: boolean;
  state: BranchPagerStateV2;
}>) {
  const reasonId = useId();
  const disabled = Boolean(disabledReason || pending);
  const description = pending ? "Переключаем версию…" : disabledReason;

  return (
    <div className="v2-branch-pager-wrap">
      <nav
        aria-label="Версии сообщения"
        aria-describedby={description ? reasonId : undefined}
        className="v2-branch-pager"
        data-testid="branch-pager"
      >
        <button
          aria-label="Предыдущая версия"
          disabled={disabled || state.previousLeafId === null}
          onClick={() => state.previousLeafId && onCheckout(state.previousLeafId)}
          type="button"
        >
          ‹
        </button>
        <span aria-label={`Версия ${state.current} из ${state.total}`}>
          {state.current}/{state.total}
        </span>
        <button
          aria-label="Следующая версия"
          disabled={disabled || state.nextLeafId === null}
          onClick={() => state.nextLeafId && onCheckout(state.nextLeafId)}
          type="button"
        >
          ›
        </button>
      </nav>
      {description ? (
        <span className="v2-branch-pager-reason" id={reasonId}>{description}</span>
      ) : null}
    </div>
  );
}

export function BranchPagerSlotV2({
  disabledReason = null,
  graph,
  messageId,
  onCheckout
}: Readonly<{
  disabledReason?: string | null;
  graph: ChatBranchGraphWire | null;
  messageId: string;
  onCheckout(leafId: string): void;
}>) {
  const state = graph ? branchPagerForMessageV2(graph, messageId) : null;
  if (!state) return null;
  return (
    <BranchPagerV2
      disabledReason={disabledReason}
      onCheckout={onCheckout}
      state={state}
    />
  );
}

function versionKindLabel(kind: BranchVersionV2["kind"]): string {
  if (kind === "original") return "Исходная версия";
  if (kind === "edited_question") return "Правка вопроса";
  if (kind === "regenerated_answer") return "Перегенерация ответа";
  return "Альтернативная версия";
}

function statusLabel(status: BranchVersionV2["status"]): string {
  if (status === "complete") return "Готова";
  if (status === "cancelled") return "Остановлена";
  if (status === "error") return "С ошибкой";
  if (status === "streaming") return "Выполняется";
  return "В очереди";
}

function BranchVersionRow({
  checkoutDisabledReason,
  checkoutPending,
  onCheckout,
  pending,
  version
}: Readonly<{
  checkoutDisabledReason: string | null;
  checkoutPending: boolean;
  onCheckout(version: BranchVersionV2): void;
  pending: boolean;
  version: BranchVersionV2;
}>) {
  return (
    <li className="v2-branch-version" data-current={version.active || undefined}>
      <span className="v2-branch-version-mark" aria-hidden="true" />
      <span className="v2-branch-version-copy">
        <span>
          <strong>Версия {version.ordinal}</strong>
          <small>{versionKindLabel(version.kind)}</small>
        </span>
        <span className="v2-branch-version-preview">{version.preview}</span>
        <small>
          {version.messageCount} {version.messageCount === 1 ? "сообщение" : "сообщений"} · {statusLabel(version.status)}
        </small>
      </span>
      {version.active ? (
        <span className="v2-branch-current" aria-current="true">Текущая</span>
      ) : (
        <UiV2Button
          busy={pending}
          disabled={Boolean(checkoutDisabledReason || checkoutPending)}
          onClick={() => onCheckout(version)}
          title={checkoutDisabledReason ?? undefined}
        >
          Переключиться
        </UiV2Button>
      )}
    </li>
  );
}

export function BranchDrawerV2({
  checkoutDisabledReason = null,
  error = null,
  graph,
  loading = false,
  onCheckout,
  onClose,
  onRetry
}: Readonly<{
  checkoutDisabledReason?: string | null;
  error?: string | null;
  graph: ChatBranchGraphWire | null;
  loading?: boolean;
  onCheckout(leafId: string): Promise<boolean | void> | boolean | void;
  onClose(): void;
  onRetry?(): void;
}>) {
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [pendingLeafId, setPendingLeafId] = useState<string | null>(null);
  const {
    dialogRef,
    initialFocusRef: closeRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({
    closeBlocked: pendingLeafId !== null,
    onClose
  });
  const versions = graph ? branchVersionsV2(graph) : [];

  async function checkout(version: BranchVersionV2) {
    if (pendingLeafId || checkoutDisabledReason) return;
    setCheckoutError(null);
    setPendingLeafId(version.checkoutLeafId);
    try {
      const succeeded = await onCheckout(version.checkoutLeafId);
      if (succeeded === false) {
        setCheckoutError("Не удалось переключить версию. Текущая ветвь не изменилась.");
        return;
      }
      onClose();
    } catch {
      setCheckoutError("Не удалось переключить версию. Текущая ветвь не изменилась.");
    } finally {
      setPendingLeafId(null);
    }
  }

  const drawer = (
    <div
      className="v2-branch-scrim"
      data-testid="branch-drawer-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pendingLeafId) onClose();
      }}
      role="presentation"
    >
      <aside
        aria-busy={pendingLeafId !== null}
        aria-label="Ветви разговора"
        aria-modal="true"
        className="v2-branch-drawer"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="v2-branch-drawer-header">
          <span>
            <small>История разговора</small>
            <h2>Ветви</h2>
          </span>
          <UiV2IconButton
            disabled={Boolean(pendingLeafId)}
            icon="close"
            label="Закрыть ветви"
            onClick={onClose}
            ref={closeRef}
          />
        </header>
        <p className="v2-branch-drawer-copy">
          Переключение меняет активную ветвь для будущих сообщений. История не изменяется.
        </p>
        {checkoutDisabledReason ? (
          <p className="v2-branch-disabled-guidance" role="status">
            {checkoutDisabledReason}
          </p>
        ) : null}
        {checkoutError ? (
          <p className="v2-branch-error" role="alert">{checkoutError}</p>
        ) : null}
        <div className="v2-branch-drawer-scroll">
          {loading ? (
            <div className="v2-branch-loading" aria-label="Загружаем ветви" role="status">
              <UiV2Skeleton />
              <UiV2Skeleton />
              <UiV2Skeleton />
            </div>
          ) : error ? (
            <div className="v2-branch-error-state" role="alert">
              <strong>Не удалось загрузить ветви</strong>
              <p>Текущая версия не изменилась.</p>
              {onRetry ? <UiV2Button onClick={onRetry}>Повторить</UiV2Button> : null}
            </div>
          ) : versions.length === 0 ? (
            <div className="v2-branch-empty">
              <strong>Ветвей пока нет</strong>
              <p>Отредактируйте сообщение или перегенерируйте ответ, чтобы создать новую версию.</p>
            </div>
          ) : (
            <ol className="v2-branch-version-list">
              {versions.map((version) => (
                <BranchVersionRow
                  checkoutDisabledReason={checkoutDisabledReason}
                  checkoutPending={pendingLeafId !== null}
                  key={version.checkoutLeafId}
                  onCheckout={checkout}
                  pending={pendingLeafId === version.checkoutLeafId}
                  version={version}
                />
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );

  return portalReady ? createPortal(drawer, document.body) : null;
}

export function BranchesSlotV2({ children }: { children: ReactNode }) {
  return <div className="v2-branches-slot">{children}</div>;
}
