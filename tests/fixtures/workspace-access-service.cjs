// Synthetic opt-in service, run only inside the smoke's owned guest execution.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const { join } = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { Server } = require("ssh2");

assert.equal(process.env.AIQSA_WORKSPACE_ACCESS_FIXTURE, "DISPOSABLE");
const root = "/workspace/tmp/access-fixture";
assert.equal(process.cwd(), root);
const config = JSON.parse(fs.readFileSync(join(root, "fixture.json"), "utf8"));
const packed = (bytes) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};
const mpint = (value) => {
  const bytes = Buffer.from(value, "base64url");
  return packed(bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
};
const keys = config.keys.map((jwk) => ({
  bytes: Buffer.concat([packed(Buffer.from("ssh-rsa")), mpint(jwk.e), mpint(jwk.n)]),
  key: crypto.createPublicKey({ key: jwk, format: "jwk" })
}));
for (const name of ["personal", "work"]) {
  const directory = join(root, name);
  assert.equal(fs.existsSync(directory), false);
  execFileSync("git", ["init", "-q", directory]);
  fs.writeFileSync(join(directory, "README.txt"), `synthetic ${name} repository\n`);
  execFileSync("git", ["-C", directory, "add", "README.txt"]);
  execFileSync("git", ["-C", directory, "-c", "user.name=Synthetic fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "-m", "Synthetic fixture"]);
  execFileSync("git", ["clone", "--quiet", "--bare", directory, join(root, `${name}.git`)]);
}
const hostKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" });
const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
  let account = -1;
  client.on("error", () => undefined);
  client.on("authentication", (context) => {
    if (context.method !== "publickey" || context.username !== "git") return context.reject();
    const index = keys.findIndex(({ bytes }) => bytes.equals(context.key.data));
    if (index < 0) return context.reject();
    if (context.signature && !crypto.verify(context.hashAlgo || "sha1", context.blob, keys[index].key, context.signature)) return context.reject();
    account = index;
    context.accept();
  });
  client.on("ready", () => client.on("session", (accept) => {
    const session = accept();
    session.on("exec", (acceptExec, reject, info) => {
      const name = ["personal", "work"][account];
      if (!name || info.command !== `git-upload-pack '/${name}.git'`) return reject();
      const stream = acceptExec();
      const child = spawn("git-upload-pack", [join(root, `${name}.git`)], { stdio: ["pipe", "pipe", "pipe"] });
      stream.pipe(child.stdin);
      child.stdin.on("error", () => undefined);
      // Send the process status before closing the SSH channel; automatic pipe
      // EOF can otherwise discard upload-pack's final response/status.
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream.stderr, { end: false });
      child.on("error", () => { stream.exit(1); stream.end(); });
      child.on("close", (code) => { stream.exit(code || 0); stream.end(); });
      stream.on("close", () => { if (child.exitCode === null) child.kill(); });
    });
  }));
});
const web = http.createServer((request, response) => {
  const expected = request.url === "/token" ? `Bearer ${config.token}`
    : request.url === "/basic" ? `Basic ${Buffer.from(`${config.login}:${config.password}`).toString("base64")}`
    : request.url === "/file" ? `Bearer ${config.fileToken}`
    : request.url === "/text" ? `Bearer ${config.textToken}` : null;
  const ok = expected !== null && request.headers.authorization === expected;
  response.writeHead(ok ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ ok }));
});
Promise.all([
  new Promise((resolve) => ssh.listen(22022, "127.0.0.1", resolve)),
  new Promise((resolve) => web.listen(28080, "127.0.0.1", resolve))
]).then(() => fs.writeFileSync(join(root, "ready"), "ready"));
setTimeout(() => process.exit(0), 300_000);
