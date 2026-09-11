import { execFile } from "node:child_process";
import { resolveRuntimeModulePath } from "../../runtimeModulePath";
import { WorkspaceSecretError } from "./validation";

// Parsing an encrypted OpenSSH key can involve a caller-controlled bcrypt KDF.
// Keep that CPU work outside the app event loop and bound its memory and time.
const VALIDATE_KEY = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; if (input.length > 65536) process.exit(1); });
process.stdin.on("end", () => {
  try {
    const { privateKey, passphrase } = JSON.parse(input);
    if (!/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(privateKey.trim())) process.exit(1);
    const parsed = require(process.argv[1]).utils.parseKey(privateKey, passphrase || undefined);
    const keys = Array.isArray(parsed) ? parsed : [parsed];
    process.exit(keys.length === 1 && !(keys[0] instanceof Error) && keys[0].isPrivateKey() ? 0 : 1);
  } catch { process.exit(1); }
});
`;
let activeParsers = 0;

export async function validateWorkspaceSshKey(privateKey: string, passphrase: string): Promise<void> {
  if (activeParsers >= 2) throw new WorkspaceSecretError("workspace_secret_unavailable");
  activeParsers++;
  try {
    const modulePath = resolveRuntimeModulePath("ssh2");
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, ["--max-old-space-size=64", "-e", VALIDATE_KEY, modulePath], {
        env: { NODE_ENV: "production" }, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 256
      }, (error) => error ? reject(new WorkspaceSecretError("workspace_secret_ssh_invalid")) : resolve());
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(JSON.stringify({ privateKey, passphrase }));
    });
  } finally { activeParsers--; }
}
