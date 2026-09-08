#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This gate owns a fresh directory, Compose project, image tag and synthetic data.
assert.equal(process.argv[2], "--disposable", "Explicit --disposable acknowledgement is required");
assert.equal(process.argv.length, 4, "usage: production-smoke.mjs --disposable <image-map.json>");
const images = JSON.parse(await readFile(process.argv[3], "utf8"));
const imageKeys = {
  app: "AIQSA_IMAGE",
  postgres: "AIQSA_POSTGRES_IMAGE",
  opensearch: "AIQSA_OPENSEARCH_IMAGE",
  docling: "AIQSA_DOCLING_IMAGE",
  tika: "AIQSA_TIKA_IMAGE"
};
for (const name of Object.keys(imageKeys)) {
  assert.match(images[name], /^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/u, `Invalid ${name} image reference`);
}
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(path.join(os.tmpdir(), "aiqsa-production-smoke-"));
const nonce = randomBytes(6).toString("hex");
const project = `aiqsa-production-smoke-${nonce}`;
const upgradeImage = `${project}:upgrade`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:AIQSA_|COMPOSE_|S3_)/u.test(key) && !["DATABASE_URL", "NODE_OPTIONS"].includes(key)));
environment.BUILDX_CONFIG = path.join(root, "buildx");
let composeValidated = false;
const secrets = [];

function sanitize(text) {
  for (const secret of secrets) if (secret.length > 12) text = text.replaceAll(secret, "[redacted]");
  return text;
}

async function command(program, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(output).toString("utf8");
      if (code !== 0) reject(new Error(sanitize(`${program} failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(-6000)}${stdout.slice(-2000)}`)));
      else resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

const docker = (...args) => command("docker", args);
const compose = (...args) => docker("compose", "--project-name", project, ...args);
const inApp = (script) => command("docker", ["compose", "--project-name", project, "exec", "-T", "app", "node", "--input-type=module", "-"], script);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const stateScript = `
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
const db = new PrismaClient();
try {
  const user = await db.user.findUniqueOrThrow({where:{email:'release-check@example.invalid'}});
  const identity = await db.authIdentity.findFirstOrThrow({where:{userId:user.id,provider:'password'}});
  const settings = await db.userSettings.findUniqueOrThrow({where:{userId:user.id}});
  const chat = await db.chat.findFirstOrThrow({where:{userId:user.id,title:'Persistent release fixture'}});
  const state = {userId:user.id,displayName:user.displayName,passwordHash:identity.passwordHash,showCitations:settings.showCitations,chatId:chat.id,title:chat.title};
  console.log(createHash('sha256').update(JSON.stringify(state)).digest('hex'));
} finally { await db.$disconnect(); }
`;

try {
  for (const name of ["compose.yaml", ".env.example"]) await copyFile(path.join(source, name), path.join(root, name));
  await command("sh", [path.join(source, "scripts/configure.sh")]);
  let configuration = await readFile(path.join(root, ".env"), "utf8");
  for (const line of configuration.split("\n")) {
    if (/^AIQSA_.*(?:SECRET|PASSWORD|KEY)/u.test(line)) secrets.push(line.slice(line.indexOf("=") + 1));
  }
  const appPort = await freePort();
  configuration = configuration.replace("AIQSA_INITIAL_ADMIN_EMAIL=\n", "AIQSA_INITIAL_ADMIN_EMAIL=release-check@example.invalid\n")
    .replace("AIQSA_APP_BASE_URL=http://localhost:3000", `AIQSA_APP_BASE_URL=http://localhost:${appPort}`);
  configuration += `\nAIQSA_PORT=${appPort}\nAIQSA_BIND_ADDRESS=127.0.0.1\n`;
  for (const [name, key] of Object.entries(imageKeys)) {
    configuration += `${key}=${images[name]}\n`;
  }
  await writeFile(path.join(root, ".env"), configuration, { mode: 0o600 });
  const config = JSON.parse(await compose("config", "--format", "json"));
  assert.equal(config.name, project);
  for (const [name, service] of Object.entries(config.services)) {
    assert.equal(service.build, undefined, `${name} must use a prebuilt image`);
    assert.ok(!service.container_name, "Service names must belong to the disposable project");
    if (name !== "app") assert.ok(!service.ports?.length, "Data services must have no published ports");
    for (const volume of service.volumes ?? []) {
      if (volume.type === "bind") assert.equal(volume.source, "/var/run/docker.sock");
    }
    for (const key of ["AIQSA_TEST_MODE", "PLAYWRIGHT_TEST_AUTH", "AIQSA_BOOTSTRAP_LOGIN_ENABLED"]) {
      assert.ok(!service.environment?.[key], `${key} must not be enabled`);
    }
  }
  for (const volume of Object.values(config.volumes)) {
    assert.equal(Boolean(volume.external), false);
    assert.ok(volume.name.startsWith(`${project}_`));
  }
  for (const network of Object.values(config.networks)) {
    assert.equal(Boolean(network.external), false);
    assert.ok(network.name.startsWith(`${project}_`));
  }
  assert.equal(await docker("ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`), "");
  composeValidated = true;
  if (images.pull !== false) await compose("pull");
  for (const image of Object.keys(imageKeys).map((name) => images[name])) {
    try { await docker("image", "inspect", image); }
    catch { await docker("pull", image); }
  }
  // The unchanged local tag models the image replacement performed by pull.
  await docker("tag", images.app, upgradeImage);
  configuration = configuration.replace(/^AIQSA_IMAGE=.+$/mu, `AIQSA_IMAGE=${upgradeImage}`);
  await writeFile(path.join(root, ".env"), configuration, { mode: 0o600 });
  console.log("production smoke: starting a fresh production installation");
  await compose("up", "-d", "--wait", "--wait-timeout", "600");
  assert.equal(await inApp("console.log((await fetch('http://127.0.0.1:3000/api/health/ready')).status)"), "200");
  await inApp(`
    import { PrismaClient } from '@prisma/client';
    const db = new PrismaClient();
    try {
      const user = await db.user.findUniqueOrThrow({where:{email:'release-check@example.invalid'}});
      await db.user.update({where:{id:user.id},data:{displayName:'Persistent release fixture'}});
      await db.userSettings.update({where:{userId:user.id},data:{showCitations:false}});
      await db.chat.create({data:{userId:user.id,title:'Persistent release fixture'}});
    } finally { await db.$disconnect(); }
  `);
  const before = await inApp(stateScript);
  assert.match(before, /^[a-f0-9]{64}$/u);
  const oldApp = await compose("ps", "--quiet", "app");
  const initialImage = await docker("image", "inspect", "--format", "{{.Id}}", upgradeImage);
  const upgradeDirectory = path.join(root, "upgrade");
  await mkdir(upgradeDirectory);
  await writeFile(path.join(upgradeDirectory, "migration.sql"), 'CREATE TABLE "aiqsa_release_smoke_probe" ("id" INTEGER PRIMARY KEY);\nINSERT INTO "aiqsa_release_smoke_probe" VALUES (1);\n');
  await writeFile(path.join(upgradeDirectory, "Dockerfile"), `FROM ${images.app}\nCOPY --chown=node:node migration.sql /app/prisma/migrations/20990101000000_release_smoke/migration.sql\n`);
  console.log("production smoke: replacing the image with a forward migration");
  await docker("build", "--tag", upgradeImage, upgradeDirectory);
  assert.notEqual(await docker("image", "inspect", "--format", "{{.Id}}", upgradeImage), initialImage);
  await compose("up", "-d", "--wait", "--wait-timeout", "600");
  assert.notEqual(await compose("ps", "--quiet", "app"), oldApp);
  assert.equal(await inApp(stateScript), before, "Operator data and credentials must survive updates");
  const migrated = await inApp(`
    import { PrismaClient } from '@prisma/client';
    const db = new PrismaClient();
    try { const rows = await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM "aiqsa_release_smoke_probe"'); console.log(rows[0].count); }
    finally { await db.$disconnect(); }
  `);
  assert.equal(migrated, "1");
  await compose("up", "-d", "--wait", "--wait-timeout", "600");
  assert.equal(await inApp(stateScript), before, "A repeated up must preserve operator state");
  console.log("production smoke: verifying that a failed migration blocks the new application");
  await writeFile(path.join(upgradeDirectory, "migration.sql"), "SELECT 1 / 0;\n");
  await writeFile(path.join(upgradeDirectory, "Dockerfile"), `FROM ${upgradeImage}\nCOPY --chown=node:node migration.sql /app/prisma/migrations/20990102000000_release_smoke_failure/migration.sql\n`);
  await docker("build", "--tag", upgradeImage, upgradeDirectory);
  const failedImage = await docker("image", "inspect", "--format", "{{.Id}}", upgradeImage);
  await assert.rejects(compose("up", "-d", "--wait", "--wait-timeout", "600"), /migrate-bootstrap/u);
  const runningApp = await docker("ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=app");
  if (runningApp) assert.notEqual(await docker("inspect", "--format", "{{.Image}}", runningApp), failedImage);
  const query = (script) => command("docker", ["compose", "--project-name", project, "run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "app", "--input-type=module", "-"], script);
  assert.equal(await query(stateScript), before, "A failed upgrade must preserve operator state");
  assert.equal(await query(`
    import { PrismaClient } from '@prisma/client';
    const db = new PrismaClient();
    try {
      const rows = await db.$queryRawUnsafe(\`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE migration_name = '20990102000000_release_smoke_failure' AND finished_at IS NULL\`);
      console.log(rows[0].count);
    } finally { await db.$disconnect(); }
  `), "1");
  console.log("production smoke passed: fresh install, image replacement, forward migration, preserved credentials/settings/chat, repeated update, failed-migration gate");
} finally {
  let cleanupError;
  if (composeValidated) {
    try { await compose("down", "--volumes", "--remove-orphans"); } catch (error) { cleanupError = error; }
  }
  try { await docker("image", "rm", upgradeImage); } catch { /* Setup may have failed before its tag was created. */ }
  if (!cleanupError) await rm(root, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
  console.log("production smoke: owned containers, volumes, image tag and temporary configuration removed");
}
