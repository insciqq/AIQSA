# AIQSA Nginx site

`aiqsa.conf.template` is an HTTP-first single-host reverse proxy intended for a
loopback-only AIQSA application port. Certbot can add TLS and the HTTP redirect
after the plain HTTP site is reachable.

## Render and enable

Replace the example domain and port, then inspect the rendered file before
enabling it:

```bash
sudo test ! -e /etc/nginx/conf.d/aiqsa-http-limits.conf \
  || sudo cp -a /etc/nginx/conf.d/aiqsa-http-limits.conf /etc/nginx/conf.d/aiqsa-http-limits.conf.pre-aiqsa
sudo install -m 0644 \
  ops/nginx/aiqsa-http-limits.conf \
  /etc/nginx/conf.d/aiqsa-http-limits.conf
sudo test ! -e /etc/nginx/sites-available/aiqsa.conf \
  || sudo cp -a /etc/nginx/sites-available/aiqsa.conf /etc/nginx/sites-available/aiqsa.conf.pre-aiqsa
sed \
  -e 's/__AIQSA_DOMAIN__/aiqsa.example.com/g' \
  -e 's/__AIQSA_LOOPBACK_PORT__/3100/g' \
  ops/nginx/aiqsa.conf.template \
  | sudo tee /etc/nginx/sites-available/aiqsa.conf >/dev/null
sudo ln -sfn /etc/nginx/sites-available/aiqsa.conf /etc/nginx/sites-enabled/aiqsa.conf
sudo nginx -t
sudo systemctl reload nginx
```

Use a DNS hostname and a numeric loopback port only. Keep the AIQSA container or
published application port bound to `127.0.0.1`. The forwarding-header lines
must continue to overwrite, rather than append, browser-supplied values when
`AIQSA_TRUST_PROXY_HEADERS=1` and `AIQSA_TRUSTED_PROXY_COUNT=1` are enabled.
AIQSA requires exactly one valid `X-Forwarded-For` entry for this template and
does not fall back to `X-Real-IP`; an extra or malformed chain is treated as
unavailable identity.
The dedicated JSON access log contains only timestamp, generated request id,
method, status, and timings: no IP address, query string, share/reset token,
message content, or header value. `X-Request-ID` lets an operator correlate a
failed response with that privacy-safe record.

The ordinary site limit is 2 MiB. The exact `/api/uploads` location permits a
32 MiB multipart envelope and consumes the `aiqsa_upload_per_client` zone from
the separately installed HTTP-context include. Application limits remain
authoritative when Nginx is absent. If `AIQSA_UPLOAD_MAX_BYTES` or
`AIQSA_UPLOAD_MULTIPART_OVERHEAD_BYTES` increases, keep the upload location
strictly above their sum and validate both files with `nginx -t` before reload.
Nginx-generated ordinary/upload overflows retain the application's JSON error
codes, and upload connection saturation returns `upload_busy` with a bounded
`Retry-After` value rather than an HTML proxy error.

## Add TLS

After DNS resolves to the host and port 80 is reachable:

```bash
sudo cp -a /etc/nginx/sites-available/aiqsa.conf /etc/nginx/sites-available/aiqsa.conf.pre-certbot
sudo certbot --nginx -d aiqsa.example.com --redirect
sudo nginx -t
```

Certbot normally reloads Nginx itself. Keep the final `nginx -t` as an explicit
verification and confirm that both HTTP redirect and HTTPS application access
work afterward.

## Rollback

If validation fails before a reload, fix or remove the rendered file; the active
Nginx process is unchanged. If this replaced an existing site, restore
`aiqsa.conf.pre-aiqsa`. To undo only the TLS edit, restore the saved HTTP config:

```bash
sudo cp -a /etc/nginx/sites-available/aiqsa.conf.pre-certbot /etc/nginx/sites-available/aiqsa.conf
sudo nginx -t
sudo systemctl reload nginx
```

If the limits include also replaced an existing file, restore it before
validation:

```bash
sudo test ! -e /etc/nginx/conf.d/aiqsa-http-limits.conf.pre-aiqsa \
  || sudo cp -a /etc/nginx/conf.d/aiqsa-http-limits.conf.pre-aiqsa /etc/nginx/conf.d/aiqsa-http-limits.conf
sudo nginx -t
sudo systemctl reload nginx
```

For a completely new site with no previous config, disable it instead:

```bash
sudo rm /etc/nginx/sites-enabled/aiqsa.conf
sudo rm /etc/nginx/conf.d/aiqsa-http-limits.conf
sudo nginx -t
sudo systemctl reload nginx
```
