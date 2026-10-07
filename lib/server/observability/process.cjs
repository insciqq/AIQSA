"use strict";

const { writeEmergencyFailure } = require("./runtime.cjs");
const PROCESS_HOOKS = Symbol.for("aiqsa.observability.process-hooks.v1");
/** A fatal exit waits at most this long for the registered final write. */
const FATAL_FINAL_WRITE_MS = 2_000;

function hookState() {
  return globalThis[PROCESS_HOOKS] ??= {};
}

// One owner (the telemetry recorder) may register a bounded final write, so a
// process that dies on an unhandled error still persists what it observed,
// including its own fatal record. The leaf never learns what the task writes.
function setFatalExitTask(task) {
  hookState().fatalExitTask = typeof task === "function" ? task : null;
}

function terminate(state) {
  const task = state.fatalExitTask;
  if (state.terminating || typeof task !== "function") {
    process.exit(1);
    return;
  }
  // A second fatal error during the final write exits at once. The process
  // keeps running for at most the bound; leases recover any work it claims.
  state.terminating = true;
  process.exitCode = 1;
  setTimeout(() => process.exit(1), FATAL_FINAL_WRITE_MS);
  Promise.resolve().then(task).catch(() => undefined).finally(() => process.exit(1));
}

function installProcessFailureHooks(options = {}) {
  // Next may register its handlers before or after instrumentation, or remove
  // existing listeners during initialization. Re-install our own missing hooks
  // without replacing any framework handler or changing its nonfatal policy.
  const state = hookState();
  if (options.standalone === true) state.standalone = true;
  const handle = (event, listener, stage) => {
    const frameworkManaged = !state.standalone && process.listeners(event).some((candidate) => candidate !== listener);
    writeEmergencyFailure({
      stage,
      outcome: frameworkManaged ? "framework_managed" : "terminated",
      code: "unexpected"
    });
    if (!frameworkManaged) terminate(state);
  };
  state.uncaught ??= function uncaughtFailure(_error, origin) {
    handle("uncaughtException", state.uncaught, origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception");
  };
  state.rejection ??= function rejectedFailure() {
    handle("unhandledRejection", state.rejection, "unhandled_rejection");
  };
  if (!process.listeners("uncaughtException").includes(state.uncaught)) {
    process.on("uncaughtException", state.uncaught);
  }
  if (!process.listeners("unhandledRejection").includes(state.rejection)) {
    process.on("unhandledRejection", state.rejection);
  }
}

module.exports = { installProcessFailureHooks, setFatalExitTask };
