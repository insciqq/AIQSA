# Real-IdP stand

Fixtures and a launcher for the opt-in real identity provider scenarios in `tests/e2e/auth-real-*.spec.ts`. Run them only on a disposable host or lane, never against a persistent installation: every Playwright run resets the stand's database, and `down` removes the stand's volumes.

## What it starts

One Compose project with two networks, like an installation whose identity providers live elsewhere on the LAN:

- AIQSA's network: `app` (the Playwright image with this checkout at `/app`; Playwright's web server starts `next dev` there on `http://127.0.0.1:3000`) and its PostgreSQL. `header-proxy` (nginx, `http://127.0.0.1:8088`) and a route helper share the app's network namespace.
- A separate LAN (`172.29.147.0/24` by default) with Keycloak (realm `aiqsa`, OIDC client and SAML client), Authentik (server, worker, PostgreSQL), OpenLDAP with the `memberof` overlay and a Samba AD DC (LDAPS, `dc1.aiqsa.test`).
- A `router` container forwards the app's LAN traffic and is the identity providers' only way back to AIQSA (`http://router:3000`, used by Authentik's SCIM provider). AIQSA refuses its own container networks as an identity provider destination, so the providers must not join AIQSA's network.

Every image is pinned by digest in `stand.mjs`. The realm, the directory seed and the proxy configuration are `keycloak-realm.template.json`, `openldap-seed.ldif` and `header-proxy.conf`; the Samba users and groups are created by `stand.mjs` with `samba-tool`.

Synthetic accounts: Keycloak `alice` (`/engineers`, role `aiqsa-user`), `bob` (`/contractors`), `carol` (unverified email, `/engineers`), `dave` (`/engineers`, `/admins`, role `aiqsa-admin`); OpenLDAP `lena` (`researchers`), `oleg` (`researchers`, `ldap-admins`), `nomail`; AD `anna` (`ad-engineers`), `ivan` (`ad-engineers`, `ad-admins`). Authentik users are created by its spec through Authentik's API.

The proxy stands in for an authenticating proxy: the cookie `aiqsa_stand_user` plays its login and becomes `X-Auth-Request-Email` (`<user>@proxy.aiqsa.test`), `aiqsa_stand_groups` becomes `X-Auth-Request-Groups`, and identity headers sent by the client are overwritten.

## Running

```bash
export AIQSA_AUTH_IDP_STAND=DISPOSABLE
node tests/auth-idp/stand.mjs up --state /srv/stand/auth-idp --mode direct
node tests/auth-idp/stand.mjs test --state /srv/stand/auth-idp -- \
  tests/e2e/auth-real-keycloak-oidc.spec.ts tests/e2e/auth-real-authentik-scim.spec.ts \
  tests/e2e/auth-real-openldap.spec.ts tests/e2e/auth-real-samba-ad.spec.ts \
  tests/e2e/auth-real-keycloak-saml.spec.ts tests/e2e/auth-real-trusted-header.spec.ts \
  tests/e2e/auth-real-switches.spec.ts
node tests/auth-idp/stand.mjs down --state /srv/stand/auth-idp
```

- `--state` must be outside the repository. Generated passwords and secrets stay in its `secrets.env` (mode 0600) and reach the specs only through `spec.env` (0600); nothing secret is printed. `down --purge` deletes the directory.
- `--mode trusted` starts the app in trusted-proxy client identity mode (`AIQSA_TRUST_PROXY_HEADERS=true`, `AIQSA_TRUSTED_PROXY_COUNT=1`) with the header proxy as its base URL, as in a deployment behind an authenticating proxy (otherwise the mutation origin guard refuses the browser's sign-out through the proxy). Run `auth-real-trusted-header.spec.ts` once per mode; the other specs run on the `direct` stand (the Authentik spec skips itself in trusted mode, since SCIM pushes do not pass the proxy).
- `auth-real-auth0.spec.ts` uses a cloud tenant instead of a local IdP: it also needs `AIQSA_E2E_AUTH0_DOMAIN`, a Management API token of a disposable Auth0 tenant in `AIQSA_E2E_AUTH0_TOKEN`, and outbound internet access from the app container. It creates and removes its own applications, users and post-login Action.
- `--base FILE.json` replaces the minimal AIQSA base (app and PostgreSQL) with your own Compose JSON (`docker compose -f file.yml config --format json`); its `app` service must mount this checkout at `/app` and have dependencies installed.
- `--project`, `--app-subnet` and `--lan-subnet` keep several stands apart on one host.
- The paid scenario `auth-real-paid.spec.ts` additionally needs `CODEX_LB_API_KEY` and `CODEX_LB_BASE_URL`: put them in a 0600 file passed as `up --extra-env FILE`; without them it skips.
- Specs run serially, each restoring the sign-in rows and identity provider state it changed; the stand's identity providers persist across the spec files of one run.
- Evidence is content-free: attachments hold counts, booleans and codes; screenshots are viewport shots. The specs turn Playwright traces off because traces would record the passwords typed into the providers' forms.
