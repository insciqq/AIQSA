#!/usr/bin/env node
/**
 * Disposable real-IdP stand for the opt-in specs `tests/e2e/auth-real-*.spec.ts` (see README.md
 * beside this file). Never point it at a persistent installation: `up` and every Playwright run
 * reset the stand's own database, and `down` removes the stand's volumes.
 *
 *   AIQSA_AUTH_IDP_STAND=DISPOSABLE node tests/auth-idp/stand.mjs up   --state DIR [options]
 *   AIQSA_AUTH_IDP_STAND=DISPOSABLE node tests/auth-idp/stand.mjs test --state DIR [--project NAME] -- <playwright args>
 *   AIQSA_AUTH_IDP_STAND=DISPOSABLE node tests/auth-idp/stand.mjs down --state DIR [--project NAME] [--purge]
 *
 * `up` options: --project NAME (aiqsa-auth-idp…), --mode direct|trusted, --base COMPOSE.json (an
 * AIQSA app/postgres base whose `app` service mounts this checkout at /app; without it a minimal
 * one is used), --app-subnet CIDR, --lan-subnet CIDR, --extra-env FILE (more KEY=VALUE lines for
 * the specs, such as the paid scenario's CODEX_LB_* variables; copied, never printed).
 *
 * Generated passwords and secrets live in DIR/secrets.env (0600) and reach the specs only through
 * DIR/spec.env (0600); nothing secret is printed. DIR must be outside the repository.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

/** Every image pinned by digest; the versions the stand was verified with are in the comments. */
const IMAGES = Object.freeze({
  // goauthentik/server 2026.8.2 (server and worker)
  authentik: "ghcr.io/goauthentik/server@sha256:ff8489a5af4f4fe415ffd180a8e3c10b120bc2592d13d79dac050d977f7b9ecd",
  authentikPostgres: "postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c",
  // Keycloak 26.7.5
  keycloak: "quay.io/keycloak/keycloak@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85",
  // Router and route helper (iptables, socat, ip)
  netshoot: "nicolaka/netshoot@sha256:7f08c4aff13ff61a35d30e30c5c1ea8396eac6ab4ce19fd02d5a4b3b5d0d09a2",
  nginx: "nginx@sha256:1eadbb07820339e8bbfed18c771691970baee292ec4ab2558f1453d26153e22d",
  // osixia/openldap 1.5.0 (memberof overlay for groupOfUniqueNames)
  openldap: "osixia/openldap@sha256:18742e9c449c9c1afe129d3f2f3ee15fb34cc43e5f940a20f3399728f41d7c28",
  // Samba AD DC 4.24.7
  samba: "diegogslomp/samba-ad-dc@sha256:0bb967bc3af7d0e25e654e8b1820b7779187458a57b0ca855cf3feb1641f9655"
});

const SECRET_NAMES = [
  "PW_ALICE", "PW_BOB", "PW_CAROL", "PW_DAVE", "PW_LENA", "PW_OLEG", "PW_NOMAIL", "PW_ANNA", "PW_IVAN",
  "OIDC_CLIENT_SECRET", "KC_ADMIN_PW", "AK_SECRET_KEY", "AK_PG_PW", "AK_BOOTSTRAP_PW", "AK_BOOTSTRAP_TOKEN",
  "LDAP_ADMIN_PW", "LDAP_READONLY_PW", "SAMBA_ADMIN_PW", "DB_PW"
];
const APP = "http://127.0.0.1:3000";
/** LAN addresses of the IdPs: AIQSA refuses its own container networks as an IdP destination. */
const LAN_HOSTS = { authentik: 11, "authentik-postgres": 13, "authentik-worker": 12, keycloak: 10, openldap: 14, samba: 15 };

function fail(message) {
  console.error(`auth-idp stand: ${message}`);
  process.exit(64);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { extra: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--") {
      options.extra = rest.slice(index + 1);
      break;
    }
    if (argument === "--purge") {
      options.purge = true;
      continue;
    }
    const match = /^--(state|project|mode|base|app-subnet|lan-subnet|extra-env)$/u.exec(argument);
    if (!match || index + 1 >= rest.length) fail(`unknown or incomplete option ${argument}`);
    options[match[1]] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function secretValue() {
  // Letters and digits only (safe in sed-free templates, LDIF and samba-tool), plus every class AD wants.
  return `${randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/gu, "").slice(0, 24)}Aa1`;
}

function readEnvFile(file) {
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function writePrivate(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function render(template, values) {
  return template.replace(/__([A-Z0-9_]+)__/gu, (whole, name) => {
    if (!(name in values)) fail(`template placeholder without a value: ${name}`);
    return values[name];
  });
}

function prefix(subnet) {
  const match = /^(\d+\.\d+\.\d+)\.0\/24$/u.exec(subnet);
  if (!match) fail(`subnets must be /24 networks such as 10.231.147.0/24 (got ${subnet})`);
  return match[1];
}

/** A minimal AIQSA base: the Playwright image with this checkout at /app, and PostgreSQL. */
function builtInBase(secrets, appSubnet) {
  const dockerfile = readFileSync(path.join(repo, "Dockerfile"), "utf8");
  const devCompose = readFileSync(path.join(repo, "docker-compose.dev.yml"), "utf8");
  const playwright = /^ARG PLAYWRIGHT_IMAGE=(\S+@sha256:[0-9a-f]{64})$/mu.exec(dockerfile)?.[1];
  const postgres = /image: (pgvector\/pgvector:\S+@sha256:[0-9a-f]{64})/u.exec(devCompose)?.[1];
  if (!playwright || !postgres) fail("could not read the pinned Playwright or PostgreSQL image");
  return {
    networks: { default: { ipam: { config: [{ subnet: appSubnet }] } } },
    services: {
      app: {
        command: ["sleep", "infinity"],
        depends_on: { postgres: { condition: "service_healthy" } },
        environment: {
          AIQSA_BIND_ADDRESS: "127.0.0.1",
          AIQSA_PERSONAL_MCP_NETWORK_MODE: "container",
          DATABASE_URL: `postgresql://aiqsa:${secrets.DB_PW}@postgres:5432/aiqsa?schema=public`,
          NEXT_TELEMETRY_DISABLED: "1"
        },
        image: playwright,
        init: true,
        shm_size: "1gb",
        volumes: [`${repo}:/app`, "app_node_modules:/app/node_modules"],
        working_dir: "/app"
      },
      postgres: {
        environment: { POSTGRES_DB: "aiqsa", POSTGRES_PASSWORD: secrets.DB_PW, POSTGRES_USER: "aiqsa" },
        healthcheck: { interval: "2s", retries: 30, test: ["CMD-SHELL", "pg_isready -U aiqsa -d aiqsa"], timeout: "3s" },
        image: postgres
      }
    },
    volumes: { app_node_modules: {} }
  };
}

/** The IdPs on their own LAN, reached from the app through the router, as in an installation. */
function standCompose(base, secrets, state, appSubnet, lanSubnet) {
  const app = prefix(appSubnet);
  const lan = prefix(lanSubnet);
  const compose = structuredClone(base);
  const services = compose.services;
  if (!services?.app) fail("the base has no app service");
  const environment = services.app.environment ?? {};
  services.app.environment = Array.isArray(environment)
    ? Object.fromEntries(environment.map((entry) => entry.split(/=(.*)/su).slice(0, 2)))
    : environment;
  services.app.environment.AIQSA_APP_BASE_URL = APP;
  services.app.mem_limit ??= "12g";
  const authentikEnvironment = {
    AUTHENTIK_BOOTSTRAP_EMAIL: "akadmin@idp.aiqsa.test",
    AUTHENTIK_BOOTSTRAP_PASSWORD: secrets.AK_BOOTSTRAP_PW,
    AUTHENTIK_BOOTSTRAP_TOKEN: secrets.AK_BOOTSTRAP_TOKEN,
    AUTHENTIK_DISABLE_STARTUP_ANALYTICS: "true",
    AUTHENTIK_DISABLE_UPDATE_CHECK: "true",
    AUTHENTIK_ERROR_REPORTING__ENABLED: "false",
    AUTHENTIK_POSTGRESQL__HOST: "authentik-postgres",
    AUTHENTIK_POSTGRESQL__NAME: "authentik",
    AUTHENTIK_POSTGRESQL__PASSWORD: secrets.AK_PG_PW,
    AUTHENTIK_POSTGRESQL__USER: "authentik",
    AUTHENTIK_SECRET_KEY: secrets.AK_SECRET_KEY
  };
  services.keycloak = {
    command: ["start-dev", "--import-realm", "--http-port=8080"],
    cpus: 2.0,
    environment: { KC_BOOTSTRAP_ADMIN_PASSWORD: secrets.KC_ADMIN_PW, KC_BOOTSTRAP_ADMIN_USERNAME: "kcadmin", KC_HEALTH_ENABLED: "true" },
    healthcheck: {
      interval: "5s",
      retries: 60,
      start_period: "20s",
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q UP <&3"],
      timeout: "5s"
    },
    image: IMAGES.keycloak,
    mem_limit: "1536m",
    volumes: [`${state}/kc:/opt/keycloak/data/import:ro`]
  };
  services["authentik-postgres"] = {
    environment: { POSTGRES_DB: "authentik", POSTGRES_PASSWORD: secrets.AK_PG_PW, POSTGRES_USER: "authentik" },
    healthcheck: { interval: "2s", retries: 30, test: ["CMD-SHELL", "pg_isready -U authentik -d authentik"], timeout: "3s" },
    image: IMAGES.authentikPostgres,
    mem_limit: "512m"
  };
  for (const [name, command] of [["authentik", "server"], ["authentik-worker", "worker"]]) {
    services[name] = {
      command: [command],
      cpus: 1.5,
      depends_on: { "authentik-postgres": { condition: "service_healthy" } },
      environment: authentikEnvironment,
      image: IMAGES.authentik,
      mem_limit: "1536m"
    };
  }
  services.authentik.healthcheck = { interval: "10s", retries: 30, start_period: "60s", test: ["CMD", "ak", "healthcheck"], timeout: "10s" };
  services.openldap = {
    command: ["--copy-service"],
    environment: {
      LDAP_ADMIN_PASSWORD: secrets.LDAP_ADMIN_PW,
      LDAP_DOMAIN: "aiqsa.test",
      LDAP_ORGANISATION: "AIQSA Test",
      LDAP_READONLY_USER: "true",
      LDAP_READONLY_USER_PASSWORD: secrets.LDAP_READONLY_PW,
      LDAP_READONLY_USER_USERNAME: "readonly",
      LDAP_TLS: "false"
    },
    image: IMAGES.openldap,
    mem_limit: "512m",
    volumes: [`${state}/ldap/50-seed.ldif:/container/service/slapd/assets/config/bootstrap/ldif/custom/50-seed.ldif:ro`]
  };
  services.samba = {
    cap_add: ["SYS_ADMIN"],
    domainname: "aiqsa.test",
    environment: {
      ADMIN_PASS: secrets.SAMBA_ADMIN_PW,
      BIND_NETWORK_INTERFACES: "false",
      DNS_FORWARDER: "127.0.0.11",
      DOMAIN: "AIQSA",
      REALM: "AIQSA.TEST"
    },
    hostname: "dc1",
    image: IMAGES.samba,
    mem_limit: "1g"
  };
  services["header-proxy"] = {
    depends_on: { app: { condition: "service_started" } },
    image: IMAGES.nginx,
    mem_limit: "128m",
    network_mode: "service:app",
    volumes: [`${state}/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro`]
  };
  for (const [name, last] of Object.entries(LAN_HOSTS)) {
    services[name].networks = {
      lan: { ipv4_address: `${lan}.${last}`, ...(name === "samba" ? { aliases: ["dc1.aiqsa.test"] } : {}) }
    };
  }
  services.app.extra_hosts = [
    "host.docker.internal:host-gateway",
    `keycloak:${lan}.${LAN_HOSTS.keycloak}`,
    `authentik:${lan}.${LAN_HOSTS.authentik}`,
    `openldap:${lan}.${LAN_HOSTS.openldap}`,
    `dc1.aiqsa.test:${lan}.${LAN_HOSTS.samba}`
  ];
  // The router forwards the app's LAN traffic (NAT) and is the IdPs' only way to AIQSA (SCIM).
  services.router = {
    cap_add: ["NET_ADMIN"],
    command: ["sh", "-c", `iptables -t nat -A POSTROUTING -d ${lanSubnet} -j MASQUERADE && exec socat TCP-LISTEN:3000,fork,reuseaddr TCP:app:3000`],
    image: IMAGES.netshoot,
    mem_limit: "128m",
    networks: { default: { ipv4_address: `${app}.250` }, lan: { aliases: ["router"], ipv4_address: `${lan}.250` } },
    sysctls: { "net.ipv4.ip_forward": "1" }
  };
  services["route-helper"] = {
    cap_add: ["NET_ADMIN"],
    command: ["sh", "-c", `ip route replace ${lanSubnet} via ${app}.250 && exec sleep infinity`],
    depends_on: { app: { condition: "service_started" }, router: { condition: "service_started" } },
    image: IMAGES.netshoot,
    mem_limit: "64m",
    network_mode: "service:app"
  };
  compose.networks = { ...(compose.networks ?? {}), lan: { ipam: { config: [{ subnet: lanSubnet }] } } };
  const dependsOn = Array.isArray(services.app.depends_on)
    ? Object.fromEntries(services.app.depends_on.map((name) => [name, { condition: "service_started" }]))
    : services.app.depends_on ?? {};
  for (const name of ["keycloak", "authentik"]) dependsOn[name] = { condition: "service_healthy" };
  for (const name of ["openldap", "samba", "authentik-worker"]) dependsOn[name] = { condition: "service_started" };
  services.app.depends_on = dependsOn;
  return compose;
}

function docker(args, options = {}) {
  const stdio = options.capture ? ["ignore", "pipe", "inherit"] : "inherit";
  const result = spawnSync("docker", args, { encoding: "utf8", stdio, ...options.spawn });
  if (result.status !== 0 && !options.allowFailure) fail(`docker ${args.filter((argument) => !argument.includes("=")).slice(0, 6).join(" ")} failed (${result.status})`);
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedActiveDirectory(compose, secrets) {
  // A password travels on the exec's stdin, never as an argument of a host process.
  const exec = (script, password) => docker(
    [...compose, "exec", "-T", "samba", "sh", "-c", password === undefined ? script : `IFS= read -r PW; ${script}`],
    { allowFailure: true, capture: true, spawn: password === undefined ? {} : { input: `${password}\n`, stdio: ["pipe", "pipe", "inherit"] } }
  );
  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt += 1) {
    ready = exec("samba-tool user list >/dev/null 2>&1").status === 0;
    if (!ready) await sleep(2_000);
  }
  if (!ready) fail("the Samba DC did not become ready");
  const users = [
    ["anna", "PW_ANNA", "Anna", "Engineer", "anna@ad.aiqsa.test"],
    ["ivan", "PW_IVAN", "Ivan", "Admin", "ivan@ad.aiqsa.test"]
  ];
  for (const [name, secret, given, surname, mail] of users) {
    exec(`samba-tool user show ${name} >/dev/null 2>&1 || samba-tool user create ${name} "$PW" --given-name=${given} --surname=${surname} --mail-address=${mail} >/dev/null`, secrets[secret]);
  }
  exec("samba-tool user show svc-aiqsa >/dev/null 2>&1 || samba-tool user create svc-aiqsa \"$PW\" >/dev/null", secrets.LDAP_READONLY_PW);
  for (const group of ["ad-engineers", "ad-admins"]) exec(`samba-tool group show ${group} >/dev/null 2>&1 || samba-tool group add ${group} >/dev/null`);
  exec("samba-tool group addmembers ad-engineers anna,ivan >/dev/null 2>&1; samba-tool group addmembers ad-admins ivan >/dev/null 2>&1; true");
  const listed = (exec("samba-tool user list; samba-tool group list").stdout ?? "").split("\n").map((line) => line.trim());
  const seededUsers = listed.filter((line) => /^(anna|ivan|svc-aiqsa)$/u.test(line)).length;
  const seededGroups = listed.filter((line) => /^ad-(engineers|admins)$/u.test(line)).length;
  console.log(`auth-idp stand: AD seeded users=${seededUsers} groups=${seededGroups}`);
  if (seededUsers !== 3 || seededGroups !== 2) fail("the AD seed is incomplete");
}

function specEnvironment({ caPath, extraEnv, mode, secrets }) {
  const lines = [
    "AIQSA_AUTH_IDP_E2E=DISPOSABLE",
    `AIQSA_E2E_STAND_MODE=${mode}`,
    "AIQSA_E2E_KEYCLOAK_ISSUER=http://keycloak:8080/realms/aiqsa",
    "AIQSA_E2E_KEYCLOAK_SAML_DESCRIPTOR=http://keycloak:8080/realms/aiqsa/protocol/saml/descriptor",
    `AIQSA_E2E_KEYCLOAK_ADMIN_PASSWORD=${secrets.KC_ADMIN_PW}`,
    `AIQSA_E2E_OIDC_CLIENT_SECRET=${secrets.OIDC_CLIENT_SECRET}`,
    ...["ALICE", "BOB", "CAROL", "DAVE", "LENA", "OLEG", "NOMAIL", "ANNA", "IVAN"].map((user) => `AIQSA_E2E_PW_${user}=${secrets[`PW_${user}`]}`),
    "AIQSA_E2E_AUTHENTIK_URL=http://authentik:9000",
    `AIQSA_E2E_AUTHENTIK_TOKEN=${secrets.AK_BOOTSTRAP_TOKEN}`,
    "AIQSA_E2E_LDAP_URL=ldap://openldap:389",
    "AIQSA_E2E_LDAP_BIND_DN=cn=readonly,dc=aiqsa,dc=test",
    `AIQSA_E2E_LDAP_BIND_PASSWORD=${secrets.LDAP_READONLY_PW}`,
    // The single-user directory block of auth-ldap.spec.ts.
    "AIQSA_E2E_LDAP_BASE=ou=people,dc=aiqsa,dc=test",
    "AIQSA_E2E_LDAP_PRESET=openldap",
    "AIQSA_E2E_LDAP_USERNAME=lena",
    `AIQSA_E2E_LDAP_PASSWORD=${secrets.PW_LENA}`,
    "AIQSA_E2E_LDAP_EMAIL=lena@ldap.aiqsa.test",
    "AIQSA_E2E_AD_URL=ldaps://dc1.aiqsa.test:636",
    "AIQSA_E2E_AD_BIND_DN=svc-aiqsa@aiqsa.test",
    `AIQSA_E2E_AD_BIND_PASSWORD=${secrets.LDAP_READONLY_PW}`,
    `AIQSA_E2E_AD_CA_FILE=${caPath}`,
    "AIQSA_E2E_HEADER_PROXY_URL=http://127.0.0.1:8088",
    "AIQSA_E2E_SCIM_BASE_FROM_IDP=http://router:3000/scim/v2",
    ...(mode === "trusted" ? ["AIQSA_TRUST_PROXY_HEADERS=true", "AIQSA_TRUSTED_PROXY_COUNT=1"] : [])
  ];
  return `${[...lines, ...extraEnv].join("\n")}\n`;
}

async function main() {
  if (process.env.AIQSA_AUTH_IDP_STAND !== "DISPOSABLE") {
    fail("set AIQSA_AUTH_IDP_STAND=DISPOSABLE to confirm this host and project are disposable");
  }
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!["down", "test", "up"].includes(command)) fail("usage: stand.mjs up|test|down --state DIR [options]");
  if (!options.state) fail("--state DIR is required");
  const state = path.resolve(options.state);
  if (state === repo || state.startsWith(`${repo}${path.sep}`)) fail("--state must be outside the repository");
  const project = options.project ?? "aiqsa-auth-idp";
  if (!/^aiqsa-auth-idp(?:-[a-z0-9]+)*$/u.test(project)) fail("--project must start with aiqsa-auth-idp and use a-z, 0-9 and -");
  const composeFile = path.join(state, "compose.json");
  const compose = ["compose", "--env-file", "/dev/null", "-p", project, "-f", composeFile];
  const specEnv = path.join(state, "spec.env");
  const caFile = path.join(repo, "test-results", "auth-idp", `${project}-ad-ca.pem`);

  if (command === "down") {
    if (existsSync(composeFile)) docker([...compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
    rmSync(specEnv, { force: true });
    rmSync(caFile, { force: true });
    if (options.purge) rmSync(state, { force: true, recursive: true });
    return;
  }

  if (command === "test") {
    if (!existsSync(specEnv)) fail("no spec.env: run `up` first");
    const container = docker([...compose, "ps", "-q", "app"], { capture: true }).stdout.trim();
    if (!container) fail("the app container is not running");
    const result = spawnSync("docker", [
      "exec", "--env-file", specEnv,
      "-e", "PLAYWRIGHT_REUSE_SERVER=0", "-e", "HOME=/tmp", "-e", `AIQSA_PLAYWRIGHT_OUTPUT_DIR=/app/test-results/auth-idp/${project}`,
      container, "sh", "-c", 'npx prisma generate >/dev/null && npm run test:e2e -- "$@" --workers=1', "sh", ...options.extra
    ], { stdio: ["ignore", "inherit", "inherit"] });
    process.exit(result.status ?? 1);
  }

  const mode = options.mode ?? "direct";
  if (!["direct", "trusted"].includes(mode)) fail("--mode must be direct or trusted");
  const appSubnet = options["app-subnet"] ?? "10.231.146.0/24";
  const lanSubnet = options["lan-subnet"] ?? "10.231.147.0/24";
  mkdirSync(state, { mode: 0o700, recursive: true });
  chmodSync(state, 0o700);
  const secretsFile = path.join(state, "secrets.env");
  if (!existsSync(secretsFile)) writePrivate(secretsFile, `${SECRET_NAMES.map((name) => `${name}=${secretValue()}`).join("\n")}\n`);
  const secrets = readEnvFile(secretsFile);
  for (const name of SECRET_NAMES) if (!secrets[name]) fail(`secrets.env lacks ${name}; remove it to regenerate`);

  // The IdP containers read these; the passwords in them are the stand's synthetic ones.
  for (const directory of ["kc", "ldap", "nginx"]) mkdirSync(path.join(state, directory), { mode: 0o755, recursive: true });
  const fixture = (name) => readFileSync(path.join(here, name), "utf8");
  writeFileSync(path.join(state, "kc", "aiqsa-realm.json"), render(fixture("keycloak-realm.template.json"), {
    APP,
    OIDC_CLIENT_SECRET: secrets.OIDC_CLIENT_SECRET,
    PW_ALICE: secrets.PW_ALICE,
    PW_BOB: secrets.PW_BOB,
    PW_CAROL: secrets.PW_CAROL,
    PW_DAVE: secrets.PW_DAVE
  }), { mode: 0o644 });
  writeFileSync(path.join(state, "ldap", "50-seed.ldif"), render(fixture("openldap-seed.ldif"), {
    PW_LENA: secrets.PW_LENA,
    PW_NOMAIL: secrets.PW_NOMAIL,
    PW_OLEG: secrets.PW_OLEG
  }), { mode: 0o644 });
  writeFileSync(path.join(state, "nginx", "default.conf"), fixture("header-proxy.conf"), { mode: 0o644 });

  const base = options.base ? JSON.parse(readFileSync(path.resolve(options.base), "utf8")) : builtInBase(secrets, appSubnet);
  writePrivate(composeFile, `${JSON.stringify(standCompose(base, secrets, state, appSubnet, lanSubnet), null, 2)}\n`);

  docker([...compose, "down", "-v", "--remove-orphans"], { allowFailure: true, capture: true });
  const up = docker([...compose, "up", "-d", "--wait", "--quiet-pull"], { allowFailure: true });
  if (up.status !== 0) {
    docker([...compose, "ps"], { allowFailure: true });
    fail(`the stand did not start; inspect with: docker ${compose.join(" ")} logs <service>`);
  }
  if (!options.base) docker([...compose, "exec", "-T", "app", "sh", "-c", "[ -x node_modules/.bin/playwright ] || npm ci --no-audit --no-fund"]);
  await seedActiveDirectory(compose, secrets);

  const ca = docker([...compose, "exec", "-T", "samba", "cat", "/usr/local/samba/private/tls/ca.pem"], { capture: true }).stdout;
  if (!ca.includes("BEGIN CERTIFICATE")) fail("the Samba CA certificate could not be read");
  mkdirSync(path.dirname(caFile), { recursive: true });
  writeFileSync(caFile, ca, { mode: 0o644 });

  const extraEnv = options["extra-env"]
    ? readFileSync(path.resolve(options["extra-env"]), "utf8").split("\n").filter((line) => /^[A-Z0-9_]+=/u.test(line))
    : [];
  writePrivate(specEnv, specEnvironment({
    caPath: `/app/test-results/auth-idp/${project}-ad-ca.pem`,
    extraEnv,
    mode,
    secrets
  }));
  console.log(`auth-idp stand: up (project ${project}, mode ${mode}, extra variables ${extraEnv.length})`);
}

await main();
