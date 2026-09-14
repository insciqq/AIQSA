"use strict";

const { basename } = require("node:path");
const { installProcessFailureHooks } = require("../lib/server/observability/process.cjs");
const { announceProcess, setProcessRole } = require("../lib/server/observability/runtime.cjs");

const roles = new Map([
  ["memory-coordinator.ts", "memory_coordinator"],
  ["memory-search-worker.ts", "memory_search"],
  ["knowledge-search-worker.ts", "knowledge_search"],
  ["workspace-runner.ts", "workspace_runner"],
  ["workspace-maintenance.ts", "maintenance"],
  ["memory-identity-cutover.ts", "maintenance"],
  ["memory-semantic-cutover.ts", "maintenance"],
  ["memory-restore-reconcile.ts", "maintenance"],
  ["memory-suppression-preflight.ts", "maintenance"],
  ["knowledge-source-backfill.ts", "maintenance"],
  ["knowledge-restore-reconcile.ts", "maintenance"],
  ["knowledge-search-integrity.ts", "maintenance"],
  ["mcp-toolhive-cleanup.ts", "maintenance"],
  ["prune.ts", "maintenance"],
  ["bootstrap.ts", "bootstrap"]
]);

function installWorkerBootstrap(entrypoint = process.argv[1]) {
  const role = typeof entrypoint === "string" ? roles.get(basename(entrypoint)) : undefined;
  if (!role) return;
  // This leaf is the first side-effect import of each owned entrypoint. It has
  // no database, configuration, SDK or framework imports. Workers must retain
  // Node's fatal outcome even if a later dependency installs an error listener.
  setProcessRole(role);
  installProcessFailureHooks({ standalone: true });
  announceProcess();
}

installWorkerBootstrap();

module.exports = { installWorkerBootstrap };
