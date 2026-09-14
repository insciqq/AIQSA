"use strict";

const { writeEmergencyFailure } = require("./runtime.cjs");
const PROCESS_HOOKS = Symbol.for("aiqsa.observability.process-hooks.v1");

function installProcessFailureHooks(options = {}) {
  // Next may register its handlers before or after instrumentation, or remove
  // existing listeners during initialization. Re-install our own missing hooks
  // without replacing any framework handler or changing its nonfatal policy.
  const state = globalThis[PROCESS_HOOKS] ??= {};
  if (options.standalone === true) state.standalone = true;
  const handle = (event, listener, stage) => {
    const frameworkManaged = !state.standalone && process.listeners(event).some((candidate) => candidate !== listener);
    writeEmergencyFailure({
      stage,
      outcome: frameworkManaged ? "framework_managed" : "terminated",
      code: "unexpected"
    });
    if (!frameworkManaged) process.exit(1);
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

module.exports = { installProcessFailureHooks };
