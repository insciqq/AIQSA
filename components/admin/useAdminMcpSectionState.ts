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

export type AdminMcpSectionState = Readonly<{
  actions: Readonly<{
    closeEditor(): void;
    normalizeImport(): void;
    setForm(form: AdminMcpServerForm): void;
    setImportValue(value: string): void;
    setQuery(value: string): void;
    startCreate(): void;
    startEdit(server: AdminMcpServer): void;
    startImport(): void;
  }>;
  state: Readonly<{
    form: AdminMcpServerForm;
    importError: string | null;
    imported: boolean;
    importValue: string;
    mode: AdminMcpEditorMode;
    query: string;
  }>;
}>;

export function useAdminMcpSectionState(): AdminMcpSectionState {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<AdminMcpEditorMode>(null);
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
        } catch (error) {
          setImportError(error instanceof Error ? error.message : "The MCP configuration could not be normalized.");
        }
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
      },
      startEdit: (server: AdminMcpServer) => {
        setForm(editableMcpServerForm(server));
        setImported(false);
        setMode("edit");
      },
      startImport: () => {
        setImportError(null);
        setImportValueState("");
        setMode("import");
      }
    },
    state: {
      form,
      importError,
      imported,
      importValue,
      mode,
      query
    }
  }), [form, importError, importValue, imported, mode, query]);
}
