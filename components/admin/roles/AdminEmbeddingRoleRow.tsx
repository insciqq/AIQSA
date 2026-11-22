"use client";

import { AdminRolePicker } from "@/components/admin/roles/AdminRolePicker";
import { RoleRow } from "@/components/admin/roles/AdminRoleRow";
import { deploymentLabeller, embeddingItems, roleStatus } from "@/components/admin/roles/rolesView";
import type { AdminRolesController } from "@/components/admin/roles/useAdminRolesController";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminSystemModelPolicyCatalog } from "@/lib/contracts/adminSystemModelPolicy";

/**
 * The past-chat search embedding role. Assigning, changing or clearing the model re-embeds the whole past-chat index
 * (or stops embedding it), so each change is confirmed with its cost before it is saved. Clearing leaves search
 * matching words only.
 */
export function AdminEmbeddingRoleRow({ busy, catalog, controller, requestConfirmation }: Readonly<{
  busy: boolean;
  catalog: AdminSystemModelPolicyCatalog;
  controller: AdminRolesController;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const label = deploymentLabeller(catalog);
  const items = embeddingItems(catalog);
  const current = catalog.policy.embeddingModel ?? null;
  const undo = { embeddingProviderModelId: current?.id ?? null };

  const assign = (id: string) => {
    if (id === current?.id) return;
    const name = items.find((item) => item.id === id)?.label ?? "this model";
    requestConfirmation({
      body: `Past-chat search embeds every indexed chat again with ${name}, in the background. ` +
        "This uses provider usage for the whole past-chat index. Search keeps matching words while it runs.",
      confirmLabel: current ? "Change and re-embed" : "Assign and embed",
      dialogLabel: current ? "Change the embedding model" : "Assign the embedding model",
      icon: "check",
      onConfirm: () => { void controller.assign({ embeddingProviderModelId: id }, undo); },
      testId: "admin-embedding-assign-confirm",
      title: current ? "Change the embedding model?" : "Assign the embedding model?",
      tone: "warning"
    });
  };

  return (
    <RoleRow
      description="Used by past-chat search to find chats by meaning as well as by words. Dedicated embedding model only."
      menu={[{
        disabled: !current || busy,
        label: "Clear assignment",
        onSelect: () => requestConfirmation({
          body: "Past-chat search keeps working but matches words only, and no embedding requests are made. " +
            "Assigning a model later embeds the whole past-chat index again.",
          confirmLabel: "Clear role",
          dialogLabel: "Clear the embedding model",
          icon: "x",
          onConfirm: () => { void controller.assign({ embeddingProviderModelId: null }, undo); },
          testId: "admin-embedding-clear-confirm",
          title: "Clear the embedding model?",
          tone: "warning"
        })
      }]}
      status={roleStatus(current)}
      testId="admin-role-embedding"
      title="Embeddings"
    >
      <AdminRolePicker
        busy={busy}
        items={items}
        label="Embedding deployment"
        onSelect={assign}
        roleName="Embeddings"
        selectedId={current?.id ?? null}
        selectedLabel={current ? label(current) : null}
        testId="admin-embedding-picker"
      />
      {current && !current.available
        ? <p className="text-xs leading-5 text-ink-muted" data-testid="admin-embedding-unavailable">
            Past-chat search matches words only until this model works again. Check it in Providers.
          </p>
        : !current && items.length === 0
          ? <p className="text-xs leading-5 text-ink-muted" data-testid="admin-embedding-none">
              No embedding model has passed its check on its provider&apos;s default key. Past-chat search matches words only.
            </p>
          : null}
    </RoleRow>
  );
}
