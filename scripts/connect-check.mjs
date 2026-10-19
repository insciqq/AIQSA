// The AIQSA Connect client's checks: gofmt, go vet and go test in connect/.
// Go is not part of check:hermetic (the development image has no Go); CI
// runs this beside it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "connect");
const env = { ...process.env, GOFLAGS: "-mod=readonly", GOTOOLCHAIN: "local" };

function go(args, options = {}) {
  const result = spawnSync("go", args, { cwd: moduleDir, encoding: "utf8", env, stdio: options.capture ? "pipe" : "inherit" });
  if (result.error?.code === "ENOENT") {
    console.error("check:connect: Go is not installed. Install the Go version named in connect/go.mod (https://go.dev/dl/).");
    process.exit(1);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(result.stderr ?? "");
    console.error(`check:connect: go ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

// gofmt ships with the Go toolchain that runs the other checks.
const gofmt = path.join(go(["env", "GOROOT"], { capture: true }).trim(), "bin", "gofmt");
const unformatted = spawnSync(gofmt, ["-l", "."], { cwd: moduleDir, encoding: "utf8" });
if (unformatted.error) throw unformatted.error;
if (unformatted.status !== 0 || unformatted.stdout.trim() !== "") {
  console.error(`check:connect: gofmt -l reports unformatted files:\n${unformatted.stdout}${unformatted.stderr}`);
  process.exit(1);
}
go(["vet", "./..."]);
go(["test", "./..."]);
console.log("check:connect: gofmt, go vet and go test passed");
