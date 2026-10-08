# Self-hosting AIQSA

This guide covers requirements, installation, updates, backups, health checks, logs and sign-in methods for a single-host AIQSA installation. Start with the [Quick start](README.md#quick-start) for a first install; read this guide before your first update.

## Requirements

For local use by one person with external model providers:

- 64-bit Linux on amd64 or arm64, Docker Engine 25.0 or newer with Compose 2.29.7 or newer, bash 4 or newer, git, and OpenSSL.
- **KVM (`/dev/kvm`) is required.** Workspace runs commands in KVM virtual machines and much of AIQSA depends on it; installations without it are not supported. On cloud and other virtual machines enable nested virtualization, or use a bare-metal host.
- **Minimum: 2 CPU cores, 8 GB RAM, and 50 GB free SSD space**, plus storage for uploads and backups. Each workspace defaults to 4 GB RAM and 10 GB disk.
- **Recommended: 16 GB RAM** for several concurrent workspaces, active Knowledge ingestion and OCR.

Memory use depends on document size and workload. No GPU is required; locally hosted model servers need their own resources. OpenSearch requires [`vm.max_map_count` of at least 262144](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/#linux-settings).

## Install

```bash
git clone https://github.com/insciqq/AIQSA.git
cd AIQSA
./aiqsa.sh install --base-url http://localhost:3000 --admin-email admin@example.com
```

`install` checks the host (Docker, Compose, `vm.max_map_count`, memory, disk, port, clock and KVM), creates `.env` with unique secrets unless it already exists, starts the stack and waits until it is ready. Without flags it asks for the URL users will open and the administrator email. It never changes host settings: a failed check prints the exact command to fix it. It refuses a host without usable `/dev/kvm` before changing anything and enables Workspace with the matching KVM group. `./aiqsa.sh doctor` rechecks the host, `.env` and the running stack at any time, and `./aiqsa.sh help` lists every command and flag.

Open the configured URL ([localhost:3000](http://localhost:3000) by default) and sign in with the email and generated `AIQSA_INITIAL_ADMIN_PASSWORD` from `.env`. Configure model providers in the Control Center. For internet access, put an HTTPS reverse proxy in front of port 3000 and set the public URL in `.env`. Its upstream read timeout must exceed the Memory admission timeout (30 seconds by default, up to 120), because sending a message waits for Memory preparation. The proxy may also refuse paths under `/api/internal/` as optional hardening; AIQSA never relies on that.

To prepare `.env` without starting anything, run `./aiqsa.sh configure`, edit `.env`, then `./aiqsa.sh up` (or `docker compose up -d`).

The stack uses prebuilt images and persistent Docker volumes. Keep `.env` with your backups: it contains the keys needed to read encrypted configuration.

## Update

**Installations on v0.2.0–v0.2.30 (bundled MinIO):** back up PostgreSQL first, then update to v0.2.34, not further, and complete its [MinIO → SeaweedFS upgrade runbook](https://github.com/insciqq/AIQSA/blob/v0.2.34/UPGRADING_FROM_MINIO.md). Later releases no longer contain this one-time storage migration. Before updating past v0.2.34, remove any `minio-legacy` service and `/legacy` mount from your Compose overrides and drop `storage-migration` from `COMPOSE_PROFILES`.

**Local MCP servers are removed after v0.2.34.** Local (npm, PyPI, OCI) MCP servers and the bundled ToolHive runtime are removed; remote MCP servers are unaffected. Before the first start of the new release, set `AIQSA_ACCEPT_LOCAL_MCP_REMOVAL=1` in `.env`: startup then deletes leftover local servers and local configurations. Without it, startup stops with `local_mcp_removal_acknowledgement_required` and changes nothing; the flag is ignored once nothing local is left. Upstream OAuth grants of removed servers are not revoked; revoke them at the provider if needed. Optionally, before updating, run `docker compose --profile maintenance run --rm mcp-maintenance --execute` in the current release to remove its ToolHive workloads. `--remove-orphans` removes the `toolhive-runtime` container; afterwards remove the `<project>_toolhive_data` volume, any leftover `aiqsa-<hex>-<token>` containers and `toolhivelocal/*` images by hand.

**First update to this release.** Released checkouts up to v0.2.34 do not contain `aiqsa.sh`, so this update is manual. If `.env` pins `AIQSA_IMAGE` (the v0.2.34 runbook did), set it to the new release first, for example `AIQSA_IMAGE=ghcr.io/insciqq/aiqsa:X.Y.Z`. Then update the checkout and start the stack:

```bash
git pull --ff-only                          # installation on a branch
git fetch --tags && git checkout vX.Y.Z     # installation on a release tag (detached HEAD)
./aiqsa.sh up                               # or: docker compose pull && docker compose up -d --remove-orphans
```

**Later updates** use the CLI:

```bash
./aiqsa.sh upgrade                # installation on a branch
./aiqsa.sh upgrade --to vX.Y.Z    # installation on a release tag (detached HEAD): always pass --to
```

`upgrade` stops on local changes to tracked files or a MinIO-era installation and offers to create a backup first (`--backup` without a prompt), or asks you to confirm a current backup of PostgreSQL, object storage and `.env` (`--backup-confirmed`). It then updates the checkout with `git pull --ff-only`, or moves it to the release tag given with `--to`. Images follow the image settings in `.env` (`AIQSA_IMAGE`, `AIQSA_WORKSPACE_RUNNER_IMAGE`), otherwise the newest release: `upgrade` refuses before changing anything when a pinned image belongs to another release, or when `--to` names an older release while the images are unpinned, and prints the exact `AIQSA_IMAGE=ghcr.io/insciqq/aiqsa:X.Y.Z` line to set. It then pulls the images before any container is replaced, restarts with `--remove-orphans` and waits until the stack is ready; a Workspace runner that is not ready is only a warning, because the rest of AIQSA works without it. It never rewrites `.env`: keys new in `.env.example` are reported, and `--add-missing-keys` appends them.

The equivalent manual update: update the checkout first so Compose uses the release's configuration, then pull the images and restart:

```bash
git pull --ff-only
docker compose pull && docker compose up -d --remove-orphans
```

This tracks stable releases and applies database migrations before starting the application. See the [release notes](https://github.com/insciqq/AIQSA/releases) before updating. Images are published on [GHCR](https://github.com/insciqq/AIQSA/pkgs/container/aiqsa); their digests are included in each release.

If `docker compose pull` reports `pull access denied for minio/mc`, the checkout is older than v0.2.31: stop at v0.2.34 and follow its runbook as described above.

## Backup and restore

```bash
./aiqsa.sh backup                       # backups/<UTC time>-v<version>/ in the checkout
./aiqsa.sh backup --output /srv/aiqsa-backup
./aiqsa.sh restore /srv/aiqsa-backup    # only into an empty installation of the same version
```

`backup` is a cold copy: it stops the application and workers, dumps PostgreSQL, stops object storage, archives its volume, copies `.env` as `env`, verifies the copies and restarts exactly the services that were running, usually within minutes. It writes `postgres.dump`, `objects.tar.gz`, `env`, `manifest` and `SHA256SUMS` with private permissions. `env` holds the installation secrets, so keep backups private, and copy them to another host: a copy on the same disk does not survive the loss of the host. Schedules, retention and off-site copies are up to you. With external object storage (`AIQSA_S3_ENDPOINT`) only PostgreSQL and `.env` are copied; back up the bucket with its provider at the same time.

`restore` needs a fresh checkout of the backup's release (`git checkout vX.Y.Z`) without `.env`, Compose containers or volumes. It verifies the checksums, restores into the new volumes from an isolated project without network access or published ports, runs the Memory and Knowledge deletion reconciliation, and only then starts the installation; search indexes are rebuilt from PostgreSQL afterwards. If reconciliation fails, nothing starts and the command prints how to discard the attempt. When Workspace is enabled and this host's `/dev/kvm` belongs to another group, the new `.env` gets this host's `AIQSA_KVM_GID`. `restore` refuses backups made with external object storage (`objects=external` in the manifest): restore those by hand.

## Health and logs

Control Center → Health shows recent provider failures, server errors and background work problems. This telemetry contains no message content and stays inside the instance's PostgreSQL: counters for 30 days, incidents for 14; nothing is sent elsewhere. `./aiqsa.sh doctor` checks the host, `.env` and every container.

To diagnose a problem, read the telemetry first, then the logs around its incidents, then any error reference a user reports:

```bash
./aiqsa.sh health                          # needs attention, errors, providers, restarts, queues, incidents (24h)
./aiqsa.sh logs --errors --since 2h        # container logs of that window
./aiqsa.sh health --run 1a2b3c4d           # one failed answer's run and incidents by its reference
```

`health` works while the app container is down, takes `--since 7d` or `30d`, and `--json` for scripts and agents. Its output contains no message content, secrets or `.env` values, only codes, counts and provider connection and model names, so it is safe to paste into an issue or give to an agent.

```bash
./aiqsa.sh logs                            # last 200 lines of every service
./aiqsa.sh logs --errors --since 1h app    # AIQSA errors of the last hour
./aiqsa.sh logs --warnings --follow        # stream warnings and errors
```

`logs` masks the `.env` secrets. `--errors` and `--warnings` keep only AIQSA's JSON lines at that level and hide the plain-text logs of PostgreSQL, OpenSearch, Tika, Docling and SeaweedFS; omit them to read those services. Container logs rotate by size (`AIQSA_LOG_MAX_FILES` × `AIQSA_LOG_MAX_SIZE` per container) and are lost when a container is recreated, for example by `up` or `upgrade`; copy anything you need to keep first.

## Sign-in methods

Sign-in is configured in **Control Center → People → Sign-in**, without a restart except for the trusted header and the break-glass token. Every method card works the same way: fill in the fields, **Save**, **Test** where offered, then **Activate**; **Disable** keeps the settings. Secrets are stored encrypted and never shown again, and a blank secret field keeps the stored value. Under *Values for the identity provider* each card shows the URLs to copy into the identity provider (IdP), built from `AIQSA_APP_BASE_URL`; the examples below use `https://aiqsa.example.com`. After a failed sign-in the card names the reason, without personal data.

### Before you start

- **Network.** AIQSA reaches OIDC issuers, LDAP directories and SAML metadata URLs from the app container. LAN addresses are allowed; cloud metadata, link-local addresses, AIQSA's own ports and every address on the app container's own Docker networks are refused. Do not attach an IdP or directory container to AIQSA's Compose networks or add it to AIQSA's Compose project: run it on another host or network with a published port, under a host name that browsers and the AIQSA container resolve to the same address. The production `compose.yaml` gives the app `host.docker.internal:host-gateway` in `extra_hosts`, which this check needs to tell AIQSA's ports on the host apart from others; a custom deployment without it gets every private address refused.
- **TLS.** HTTPS endpoints need a certificate from a public CA; only the LDAP card takes a pasted CA certificate. Plain `http://` is accepted only for private addresses, and OIDC requests follow no redirects.
- **Public paths.** Cloud IdPs post to `/saml/acs` and call `/scim/v2` at your public URL, so the reverse proxy must forward them like the rest of AIQSA.
- **Email linking.** A first external sign-in joins an existing account with the same email only when the IdP marks the email verified, the method's email trust switch is on, or SCIM provisioned that account. Otherwise it is refused as an account conflict, and a new account made from an unverified email gets no email address. Later sign-ins match the IdP's stable subject, not the email.
- **Groups and administrators.** OIDC, LDAP, SAML and the trusted header share three settings. **Allowed groups** admits only members (empty admits everyone the IdP signs in; a sign-in without the groups claim is then refused). **Administrator groups** grants the administrator role; the IdP removes it only from administrators it promoted, and the last active administrator keeps it. Group sync changes only AIQSA groups that carry an external name for that method: in **Control Center → People → Groups**, open the group and add under *External names* the value exactly as the IdP sends it (case-sensitive). AIQSA never creates groups from claims, a sign-in without groups changes nothing, and managed memberships cannot be edited by hand.
- **Changing the IdP.** OIDC, LDAP, SAML and trusted-header identities are bound to the configured issuer, directory or IdP entity ID. Activating a different one asks for confirmation and names how many people stop signing in; unlink their old identities on their user pages so the next sign-in links again.

### Google and Yandex

Create a Google OAuth client (*Google Cloud Console → APIs & Services → Credentials → OAuth client ID*, type *Web application*) or a Yandex ID app for web services with access to the email address, with the card's redirect URI (`https://aiqsa.example.com/api/auth/oauth/google/callback` or `…/yandex/callback`). Enter **Client ID** and **Client secret** on the card, **Save**, **Test** (a format check; the first real sign-in proves the client) and **Activate**. Who may join is decided by **Sign-up rules**.

**Moving from `.env` to the admin panel.** With `AIQSA_GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` or `AIQSA_YANDEX_OAUTH_CLIENT_ID`/`_SECRET` set, the card shows *Active (environment)*. The variables stay a fallback only while no admin configuration of that provider is active:

1. Enter the same client ID and secret on the card, **Save**, **Test**, **Activate**. The status becomes *Active (admin)*; the redirect URI and existing users' links stay the same.
2. Sign in with the provider in a private window to confirm.
3. Remove both variables from `.env` and run `./aiqsa.sh up` (or `docker compose up -d`): a plain restart keeps the old environment.

Until the variables are removed, disabling the card falls back to them.

### Microsoft Entra ID

Written from Microsoft's documentation, not checked against a tenant.

**OIDC.** *App registrations → New registration*: single tenant (*Accounts in this organizational directory only*), platform *Web* with the OpenID Connect card's redirect URI. Then:

- *Certificates & secrets*: create a client secret and copy its **Value**.
- *Token configuration*: *Add groups claim* with *Group ID* in the ID token, and the optional ID token claim `email`; users without an email cannot sign in.
- For **Sign out at the provider**, also add the post-logout URI (`https://aiqsa.example.com/login`) as a Web redirect URI.

On the card: **Issuer** `https://login.microsoftonline.com/<tenant-id>/v2.0` (the multi-tenant `common`, `organizations` and `consumers` issuers are refused), **Client ID** = the Application (client) ID, the secret, **Groups claim** `groups`. Entra sends group object IDs (GUIDs), so enter GUIDs in Allowed and Administrator groups and as OIDC external names. Above 200 groups Entra sends an overage pointer instead of the list; AIQSA does not query Microsoft Graph and treats the groups as missing, so prefer *Groups assigned to the application*. Entra sends no `email_verified`: linking existing accounts needs **Trust unverified email** (only for a tenant whose addresses you control) or SCIM.

**SCIM** needs a separate enterprise application: *Enterprise applications → New application → Create your own application* (non-gallery), *Provisioning → Automatic*, **Tenant URL** = the SCIM card's base URL, **Secret Token** = a SCIM token, *Test Connection*, then start provisioning for the assigned users and groups. Entra maps `userPrincipalName` to `userName` by default, and `userName` becomes the AIQSA email: map `mail` instead when they differ. Set the SCIM card's link method to OIDC.

**SAML** instead of OIDC, in a non-gallery enterprise application under *Single sign-on → SAML*: **Identifier (Entity ID)** = SP entity ID, **Reply URL** = ACS URL, **Sign on URL** = `https://aiqsa.example.com/api/auth/saml/start` (AIQSA refuses IdP-initiated sign-in; with this URL, opening the app from My Apps starts a normal sign-in). Add a group claim with *Group ID*. On the SAML card load the *App Federation Metadata Url*, then set **Email attribute** `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`, **Groups attribute** `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups`, and for a stable subject **Subject attribute** `http://schemas.microsoft.com/identity/claims/objectidentifier` with NameID format *Unspecified*.

### Keycloak

**OIDC.** *Clients → Create client*, type OpenID Connect: **Client authentication** on, **Standard flow** on, **Valid redirect URIs** = the card's redirect URI, **Valid post logout redirect URIs** = the post-logout URI, and under *Advanced* the PKCE method `S256`. Copy the secret from *Credentials*. On the card: **Issuer** `https://keycloak.example.com/realms/<realm>`, the client ID and secret. Keycloak derives its issuer from the request's host unless its hostname is configured (`KC_HOSTNAME`); configure it so that browsers and AIQSA see the same issuer, otherwise Test reports an issuer mismatch.

AIQSA reads one **Groups claim** for Allowed groups, Administrator groups and sync:

- Groups: in *Client scopes → &lt;client&gt;-dedicated*, add a *Group Membership* mapper with token claim name `groups` and *Add to ID token* on. *Full group path* on sends `/team` and `/parent/team`, off sends `team`. A mapper that adds groups only to userinfo needs **Groups from** *Userinfo* or the default *ID token, then userinfo*.
- Realm roles: **Groups claim** `realm_access.roles`. The *realm roles* mapper of the built-in `roles` scope adds them only to the access token; turn on *Add to ID token* or *Add to userinfo*.
- Client roles: `resource_access.<client-id>.roles`, through the *client roles* mapper in the same way.

Keycloak leaves `realm_access` out of the token when the user has no realm role, and a sign-in without the claim changes nothing: removing the user's last role keeps their AIQSA memberships and administrator role. Keep the realm's default role `default-roles-<realm>` assigned (Keycloak assigns it to new users) so the claim is always present.

Keycloak sends `email_verified` from the user's *Email verified* flag.

**SAML.** *Clients → Create client*, type SAML: **Client ID** = the SAML card's SP entity ID, **Valid redirect URIs** and *Advanced → Assertion Consumer Service POST Binding URL* = the ACS URL. Turn on *Sign assertions*, set *Name ID format* `persistent` with *Force name ID format*, turn off *Keys → Client signature required* (AIQSA does not sign requests) and leave assertion encryption off. In the dedicated scope add a *User Property* mapper `email` → SAML attribute `email` and a *Group list* mapper `groups` with *Single group attribute* on, or use the role list attribute `Role`. On the SAML card load `https://keycloak.example.com/realms/<realm>/protocol/saml/descriptor` and set **Email attribute** `email` and **Groups attribute** `groups` or `Role`.

### Authentik

**OIDC.** Create an application with an *OAuth2/OpenID Provider*: confidential client, the card's redirect URI, the *authorization code* grant type (without it Authentik answers the sign-in with `invalid_request`), and a **Signing Key** such as the bundled self-signed certificate. Without a signing key Authentik signs ID tokens with HS256, which AIQSA refuses. On the card: **Issuer** `https://authentik.example.com/application/o/<application-slug>/`, with the trailing slash. The `groups` claim (group names) comes with the default `profile` scope. The default `email` scope sends `email_verified: false`, so linking existing accounts needs **Trust unverified email**, a custom scope mapping that reports the address as verified, or SCIM.

**SCIM.** Create a *SCIM Provider* with **URL** = the SCIM card's base URL and **Token** = a SCIM token, and add it to the application as a *Backchannel provider*. Authentik's default user mapping sends the username as `userName`; AIQSA then takes the primary email, but a mapping that sends the email as `userName` keeps both sides on one key. Set the SCIM card's link method to OIDC so the first Authentik sign-in links the pushed account.

### Okta

Written from Okta's documentation, not checked against a tenant.

**OIDC.** *Applications → Create App Integration → OIDC - OpenID Connect → Web Application*, grant type *Authorization Code*, with the card's redirect URI as **Sign-in redirect URI** and its post-logout URI as **Sign-out redirect URI**, assigned to the people who may use AIQSA. The issuer is `https://<okta-domain>` for the org authorization server or `https://<okta-domain>/oauth2/default` for the default custom one. For groups, set the app's *Sign On → OpenID Connect ID Token → Groups claim filter* (`groups`, *Matches regex* `.*` or narrower) on the org server, or add a `groups` claim of value type *Groups* to the ID token on a custom server.

**SCIM.** Turn on SCIM provisioning in the app integration's general settings; under *Provisioning → Integration* set **SCIM connector base URL** = the SCIM card's base URL, **Unique identifier field for users** = `userName`, the push actions (new users, profile updates, groups) and *HTTP Header* authentication with a SCIM token. The Okta username becomes the AIQSA email, so it must be the email address.

### LDAP and Active Directory

People sign in on the normal login form. While password sign-in is on, an email with a local AIQSA password keeps using it, so keep one local administrator for emergencies; every other name goes to the directory. Use a read-only service account (**Bind DN**, **Bind password**) or leave Bind DN empty to search anonymously. Enter a **Sample sign-in name** before **Test**: AIQSA binds as the service account, searches for that name and reports whether the id and email attributes exist and how many groups it found, without signing in as that user.

**OpenLDAP.** Start from the *OpenLDAP* preset: filter `(uid={{username}})` (or `(mail={{username}})` to sign in by email), id attribute `entryUUID`, groups attribute `memberOf`. **Server URL** `ldaps://ldap.example.com`, or `ldap://` with **Use StartTLS**; paste the CA certificate if it is private. `memberOf` exists only with the `memberof` overlay, which records memberships added after it was loaded; the osixia/openldap image enables it for `groupOfUniqueNames` groups with `uniqueMember`.

**Active Directory.** Start from the *Active Directory* preset: filter `(sAMAccountName={{username}})`, id attribute `objectGUID`, groups attribute `memberOf`. Use `ldaps://dc1.example.com` (port 636) and paste the domain's CA certificate: Active Directory and Samba AD refuse simple binds without TLS by default. An ordinary domain account can be the service account, for example `CN=aiqsa-reader,OU=Service Accounts,DC=example,DC=com`. `memberOf` lists direct memberships only, without nested groups or the primary group (Domain Users).

**Group values** compare the first CN (`engineers`) or the full DN (`CN=engineers,OU=Groups,DC=example,DC=com`) with Allowed groups, Administrator groups and LDAP external names. The directory owns its email addresses, so **Link accounts by directory email** is on by default; turn it off if people can edit their own `mail`.

### SCIM provisioning

On the SCIM card choose **Link SCIM users to sign-in method** (the method they will sign in with), **Save**, **Activate**, then **Generate token**. The token is shown once: copy it into the IdP together with the **SCIM base URL** (`https://aiqsa.example.com/scim/v2`). Up to five tokens can be active; rotate or revoke them on the card. A cloud IdP must reach AIQSA's public URL.

- `userName` must be the user's email (otherwise AIQSA uses the primary email); it becomes the account email. A pushed account that has no sign-in yet and is not an administrator links its first sign-in through the chosen method by email, even when that method does not trust unverified emails.
- Pushed users and groups link to an existing account with the same email or a group with the same name; a linked group keeps its grants. Their memberships then change only through SCIM, and deleting a group archives it.
- Deactivating or deleting a user in the IdP disables the account and ends its sessions and connected apps at once; nothing is erased. A user who is the only Owner of a Project stays active, the IdP gets an error and administrators see it until ownership moves and the IdP retries; meanwhile that user cannot sign in. Reactivation re-enables only accounts SCIM disabled, never one an administrator disabled.

### Trusted header

An authenticating reverse proxy (oauth2-proxy, Authelia, an Authentik outpost, Cloudflare Access) signs people in and passes their email in a header, and AIQSA signs them in from it. The proxy vouches for the email: it joins an existing account with that address, and a changed address is a new identity.

**The proxy must authenticate every request it forwards and overwrite the identity headers a client sends, and AIQSA must be reachable only through it.** Any other path lets anyone sign in as anyone; every process that can reach AIQSA's loopback port can do so.

1. In `.env` set `AIQSA_TRUST_PROXY_HEADERS=true`, keep the default loopback bind (`AIQSA_BIND_ADDRESS=127.0.0.1`), set `AIQSA_TRUSTED_PROXY_COUNT` to the number of proxies when there is more than one, and run `./aiqsa.sh up`. The card shows this mode but cannot turn it on.
2. On the Trusted header card pick the preset for your proxy, **Save**, **Test**, **Activate**. The card shows whether your own request carries the email header.
3. Without a session, `/login` signs people in at once; `/login?local=1` shows the other methods. Signing out of AIQSA lands on `/login?local=1`; on shared computers also sign out at the proxy (`/oauth2/sign_out` for oauth2-proxy, the logout page for Authelia).

| Preset | Email header | Name header | Groups header (separator) |
| --- | --- | --- | --- |
| oauth2-proxy | `X-Auth-Request-Email` | `X-Auth-Request-Preferred-Username` | `X-Auth-Request-Groups` (`,`) |
| Authelia | `Remote-Email` | `Remote-Name` | `Remote-Groups` (`,`) |
| Authentik | `X-Authentik-Email` | `X-Authentik-Name` | `X-Authentik-Groups` (`\|`) |
| Cloudflare Access | `Cf-Access-Authenticated-User-Email` | — | — |

nginx in front of oauth2-proxy (`--reverse-proxy --set-xauthrequest --upstream=static://202 --http-address=127.0.0.1:4180`), both on the AIQSA host, following oauth2-proxy's `auth_request` example:

```nginx
location /oauth2/ {
    proxy_pass http://127.0.0.1:4180;
    proxy_set_header Host $host;
    proxy_set_header X-Scheme $scheme;
}
location = /oauth2/auth {
    proxy_pass http://127.0.0.1:4180;
    proxy_set_header Host $host;
    proxy_set_header X-Scheme $scheme;
    proxy_set_header Content-Length "";
    proxy_pass_request_body off;
}
location / {
    auth_request /oauth2/auth;
    error_page 401 =403 /oauth2/sign_in;
    auth_request_set $email $upstream_http_x_auth_request_email;
    auth_request_set $user $upstream_http_x_auth_request_preferred_username;
    auth_request_set $groups $upstream_http_x_auth_request_groups;
    proxy_set_header X-Auth-Request-Email $email;
    proxy_set_header X-Auth-Request-Preferred-Username $user;
    proxy_set_header X-Auth-Request-Groups $groups;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3000;  # plus your TLS, timeout and upload settings
}
```

`proxy_set_header` replaces a header of the same name that the client sent. For Authelia, point `auth_request` at its `/api/authz/auth-request` endpoint and pass `Remote-Email`, `Remote-Name` and `Remote-Groups` from its response the same way. If you exempt a path from authentication, for example `/scim/v2` for a cloud SCIM client, clear the identity headers there (`proxy_set_header X-Auth-Request-Email "";`).

### Two-factor sign-in

People turn it on in **Settings → Account → Two-factor sign-in** with an authenticator app and receive ten recovery codes, shown once. It covers password and LDAP sign-ins; Google, Yandex, OIDC, SAML and the trusted header rely on the IdP's own MFA. A password reset by email keeps it on. An administrator removes a lost factor with **Reset two-factor** on the user page, which also ends the user's sessions; it is refused for their own account. Factors are encrypted with `AIQSA_ENCRYPTION_KEY`: losing that key blocks these users until an administrator resets them. The bootstrap token never asks for a code.

### Switches and break-glass

The **Password sign-in** switch turns off sign-in, access requests, invitations and resets with a password. To prevent a lockout, it can be turned off only from a session signed in through an external method that is active right now, and while it is off that method cannot be disabled from the same session. **Access requests** turns off self-service requests; invitations still work. `/login?local=1` shows the sign-in page without the automatic redirect to the OIDC provider or the trusted header.

The bootstrap token is the break-glass sign-in. It ignores the switches, two-factor sign-in and every IdP, but its account must be active:

1. Create a token and its hash: `token=$(openssl rand -hex 32); echo "$token"; printf %s "$token" | sha256sum | cut -d' ' -f1`.
2. Find the administrator's id: `docker compose exec postgres psql -U aiqsa -d aiqsa -tAc "SELECT id FROM \"User\" WHERE email = 'admin@example.com'"` (with your `AIQSA_POSTGRES_USER` and `AIQSA_POSTGRES_DB` if you changed them).
3. In `.env` set `AIQSA_BOOTSTRAP_LOGIN_ENABLED=1`, `AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256=<hash>` and `AIQSA_BOOTSTRAP_USER_ID=<id>`, then run `./aiqsa.sh up`.
4. Open `https://aiqsa.example.com/login?local=1`, run `await fetch("/api/auth/token", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({token: "<token>"})})` in the browser console, and reload.
5. Repair the sign-in settings, for example turn password sign-in back on, then remove the three variables and run `./aiqsa.sh up` again.
