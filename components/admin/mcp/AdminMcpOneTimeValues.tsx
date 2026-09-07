"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { fieldLabelClass } from "@/components/admin/mcp/mcpPrimitives";
import type { AdminMcpServer, McpConfigurationSlot, McpSlotValue } from "@/lib/contracts/mcp";

export type AdminMcpOneTimeValueDraft = Record<string, string>;

/** Fields whose value the check needs but that are not stored for the administrator: personal ones and empty shared ones. */
export function mcpOneTimeCandidates(server: AdminMcpServer): McpConfigurationSlot[] {
  return server.draft.slots.filter((slot) =>
    slot.policy.kind === "personal" ||
    (slot.policy.kind === "shared" && !server.sharedValues[slot.slotKey]?.configured));
}

function slotInputValue(slot: McpConfigurationSlot, raw: string): McpSlotValue {
  if (slot.valueType === "number") return Number(raw);
  if (slot.valueType === "boolean") return raw === "true";
  return raw;
}

/** The typed values for one request, or undefined when nothing was entered. */
export function mcpOneTimeRequest(
  server: AdminMcpServer,
  values: AdminMcpOneTimeValueDraft
): Record<string, McpSlotValue> | undefined {
  const slots = new Map(server.draft.slots.map((slot) => [slot.slotKey, slot]));
  const entries = Object.entries(values)
    .filter(([, value]) => value !== "")
    .flatMap(([slotKey, value]) => {
      const slot = slots.get(slotKey);
      return slot ? [[slotKey, slotInputValue(slot, value)] as const] : [];
    });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Values sent only with the next check (PRD 5.10): never stored, cleared as
 * soon as the request settles. Rendered only when the server has such fields.
 */
export function AdminMcpOneTimeValues({
  disabled,
  onChange,
  server,
  values
}: Readonly<{
  disabled: boolean;
  onChange(values: AdminMcpOneTimeValueDraft): void;
  server: AdminMcpServer;
  values: AdminMcpOneTimeValueDraft;
}>) {
  const candidates = mcpOneTimeCandidates(server);
  if (!candidates.length) return null;
  const set = (slotKey: string, value: string) => onChange({ ...values, [slotKey]: value });
  return (
    <div className="grid gap-3 rounded-[10px] border border-trace-subtle bg-control-surface/45 px-4 py-3" data-testid="mcp-one-time-values">
      <div>
        <p className="text-sm font-medium text-ink">Values for this check</p>
        <p className="mt-0.5 text-xs leading-5 text-ink-muted">
          Sent only with the next check and never saved. They are cleared as soon as the request finishes.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {candidates.map((slot) => (
          <label className="block min-w-0" key={slot.slotKey}>
            <span className={fieldLabelClass}>{slot.label}</span>
            {slot.valueType === "boolean" ? (
              <select
                className={inputClass}
                disabled={disabled}
                onChange={(event) => set(slot.slotKey, event.currentTarget.value)}
                value={values[slot.slotKey] ?? ""}
              >
                <option value="">Select a value</option>
                <option value="false">False</option>
                <option value="true">True</option>
              </select>
            ) : slot.valueType === "enum" ? (
              <select
                className={inputClass}
                disabled={disabled}
                onChange={(event) => set(slot.slotKey, event.currentTarget.value)}
                value={values[slot.slotKey] ?? ""}
              >
                <option value="">Select a value</option>
                {(slot.enumValues ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            ) : (
              <input
                autoComplete="new-password"
                className={inputClass}
                disabled={disabled}
                onChange={(event) => set(slot.slotKey, event.currentTarget.value)}
                type={slot.sensitive ? "password" : slot.valueType === "number" ? "number" : "text"}
                value={values[slot.slotKey] ?? ""}
              />
            )}
          </label>
        ))}
      </div>
    </div>
  );
}
