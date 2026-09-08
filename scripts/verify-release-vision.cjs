"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createRequire, registerHooks } = require("node:module");
const path = require("node:path");

// The check must work with a read-only root and leave no compiler cache in the image.
process.env.TSX_DISABLE_CACHE = "1";

async function main() {
  const role = process.argv[2];
  if (!role) {
    // Separate processes also prove the uncached fixture and native loader for
    // each production resolution root. No credentials or services are used.
    for (const target of ["application", "worker"]) {
      const result = spawnSync(process.execPath, [__filename, target], { stdio: "inherit" });
      assert.equal(result.status, 0, "vision_release_role_failed");
    }
    return;
  }
  assert.ok(["application", "worker"].includes(role), "vision_release_role_invalid");
  assert.equal(process.platform, "linux", "vision_release_platform_invalid");
  assert.ok(["x64", "arm64"].includes(process.arch), "vision_release_arch_invalid");
  assert.notEqual(process.getuid(), 0, "vision_release_requires_nonroot");
  const root = path.resolve(__dirname, "..");
  const roleRequire = createRequire(path.join(root, role === "application" ? "runtime/server.js" : "package.json"));
  const sharpPath = roleRequire.resolve("sharp");
  // Do not let a broken standalone closure silently resolve from worker deps.
  const expectedRoot = path.join(root, role === "application" ? "runtime/node_modules" : "node_modules");
  assert.ok(sharpPath.startsWith(`${expectedRoot}${path.sep}`), "vision_release_dependency_root_invalid");
  const sharpRequire = createRequire(sharpPath);
  sharpRequire(`@img/sharp-linux-${process.arch}/sharp.node`);
  const sharp = roleRequire("sharp");
  assert.equal(Boolean(sharp.versions.emscripten), false, "vision_release_wasm_fallback");

  // Execute the image producer shipped in this image, using precisely the
  // application's or worker's sharp resolution, never developer dependencies.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === "sharp" ? sharpPath : specifier, context);
    }
  });
  require("tsx/cjs/api").register();
  const { assertVisionProbeImage } = require("./vision-probe-image-oracle.ts");
  const { createProviderVisionInputProbe } = require("../lib/server/providers/visionInputProbe.ts");
  let requests = 0;
  const probe = createProviderVisionInputProbe({
    async execute(_snapshot, request) {
      requests += 1;
      assert.equal(request.attachments.length, 1, "vision_release_attachment_count_invalid");
      const attachment = request.attachments[0];
      assert.ok(attachment.dataUrl.startsWith("data:image/png;base64,"), "vision_release_attachment_invalid");
      const image = Buffer.from(attachment.dataUrl.split(",")[1], "base64");
      assert.equal(image.length, attachment.byteSize, "vision_release_attachment_size_invalid");
      await assertVisionProbeImage(image);
      assert.ok(!JSON.stringify(request.content).includes("V4K8M2"), "vision_release_answer_leaked");
      return { finalText: "V4K8M2" };
    }
  });
  const passed = await probe.probe({
    model: {
      adapterKind: "openai_chat_completions_compatible",
      capabilities: { vision: true },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "synthetic-vision-probe"
    },
    providerFamily: "custom"
  });
  assert.equal(passed, true, "vision_release_probe_failed");
  assert.equal(requests, 1, "vision_release_request_count_invalid");
  console.log(JSON.stringify({ role, architecture: process.arch, native: true, readableCode: true, sharp: sharp.versions.sharp }));
}

main().catch(() => {
  console.error("vision_release_check_failed");
  process.exitCode = 1;
});
