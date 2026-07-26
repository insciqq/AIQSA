"use client";

import {
  blankMcpServerForm,
  editableMcpServerForm,
  normalizeMcpImport,
  type AdminMcpServerForm
} from "@/components/admin/adminMcpDraft";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { useMemo, useState } from "react";

export type AdminMcpEditorMode = "create" | "edit" | "import" | null;
export type AdminMcpTask = "danger" | "definition" | "overview" | "revisions" | "runtime" | "validation";

export type AdminMcpSectionState = Readonly<{
  actions: Readonly<{
    closeEditor(): void;
    normalizeImport(): void;
    openServer(): void;
    openTask(task: AdminMcpTask): void;
    setForm(form: AdminMcpServerForm): void;
    setImportValue(value: string): void;
    setQuery(value: string): void;
    startCreate(): void;
    startEdit(server: AdminMcpServer): void;
    startImport(): void;
    showCatalog(): void;
    showTaskIndex(): void;
  }>;
  state: Readonly<{
    compactDetailOpen: boolean;
    compactTaskOpen: boolean;
    form: AdminMcpServerForm;
    importError: string | null;
    imported: boolean;
    importValue: string;
    mode: AdminMcpEditorMode;
    query: string;
    task: AdminMcpTask;
  }>;
}>;

export function useAdminMcpSectionState(): AdminMcpSectionState {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<AdminMcpEditorMode>(null);
  const [task, setTask] = useState<AdminMcpTask>("overview");
  const [compactDetailOpen, setCompactDetailOpen] = useState(false);
  const [compactTaskOpen, setCompactTaskOpen] = useState(false);
  const [form, setForm] = useState<AdminMcpServerForm>(() => blankMcpServerForm());
  const [importValue, setImportValueState] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  return useMemo(() => ({
    actions: {
      closeEditor: () => setMode(null),
      normalizeImport: () => {
        try {
          const normalized = normalizeMcpImport(importValue);
          setForm({
            description: normalized.description,
            draft: structuredClone(normalized.draft),
            name: normalized.name,
            sharedValues: { ...normalized.sharedValues }
          });
          setImported(true);
          setImportError(null);
          setMode("create");
          setCompactDetailOpen(true);
        } catch (error) {
          setImportError(error instanceof Error ? error.message : "The MCP configuration could not be normalized.");
        }
      },
      openServer: () => {
        setMode(null);
        setCompactDetailOpen(true);
        setCompactTaskOpen(false);
      },
      openTask: (nextTask) => {
        setMode(null);
        setTask(nextTask);
        setCompactDetailOpen(true);
        setCompactTaskOpen(true);
      },
      setForm,
      setImportValue: (value: string) => {
        setImportValueState(value);
        setImportError(null);
      },
      setQuery,
      startCreate: () => {
        setForm(blankMcpServerForm());
        setImported(false);
        setMode("create");
        setCompactDetailOpen(true);
      },
      startEdit: (server: AdminMcpServer) => {
        setForm(editableMcpServerForm(server));
        setImported(false);
        setMode("edit");
        setCompactDetailOpen(true);
      },
      startImport: () => {
        setImportError(null);
        setImportValueState("");
        setMode("import");
        setCompactDetailOpen(true);
      },
      showCatalog: () => setCompactDetailOpen(false),
      showTaskIndex: () => setCompactTaskOpen(false)
    },
    state: {
      compactDetailOpen,
      compactTaskOpen,
      form,
      importError,
      imported,
      importValue,
      mode,
      query,
      task
    }
  }), [compactDetailOpen, compactTaskOpen, form, importError, importValue, imported, mode, query, task]);
}
