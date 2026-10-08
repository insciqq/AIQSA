ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

FROM ${PLAYWRIGHT_IMAGE} AS dev

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "dev"]

FROM ${NODE_IMAGE} AS runtime-deps

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi \
  && npx prisma generate

FROM runtime-deps AS runtime-build

ENV NODE_ENV=production

ARG AIQSA_BUILD_NODE_OPTIONS="--max-old-space-size=8192"
ARG AIQSA_BUILD_APP_BASE_URL="https://build.invalid"

COPY . .
RUN AIQSA_APP_BASE_URL="$AIQSA_BUILD_APP_BASE_URL" \
  NODE_OPTIONS="$AIQSA_BUILD_NODE_OPTIONS" npm run build

# Retain the direct runtime-worker and installation-tool roots and let npm
# preserve their complete locked transitive closure. Deriving versions from the
# npm-ci result keeps package-lock.json authoritative without naming transitive
# packages. SheetJS is published only as a tarball, so the isolated parser keeps
# its exact package.json spec. Keep security overrides when pruning so npm
# cannot downgrade the retained worker dependencies below their reviewed versions.
FROM runtime-deps AS tools-deps

RUN PRISMA_VERSION="$(node -p "require('./node_modules/prisma/package.json').version")" \
  && PRISMA_CLIENT_VERSION="$(node -p "require('./node_modules/@prisma/client/package.json').version")" \
  && AWS_SDK_VERSION="$(node -p "require('./node_modules/@aws-sdk/client-s3/package.json').version")" \
  && S3_PRESIGNER_VERSION="$(node -p "require('./node_modules/@aws-sdk/s3-request-presigner/package.json').version")" \
  && TSX_VERSION="$(node -p "require('./node_modules/tsx/package.json').version")" \
  && SHARP_VERSION="$(node -p "require('./node_modules/sharp/package.json').version")" \
  && CANVAS_VERSION="$(node -p "require('./node_modules/@napi-rs/canvas/package.json').version")" \
  && PDF_LIB_VERSION="$(node -p "require('./node_modules/pdf-lib/package.json').version")" \
  && PDFJS_VERSION="$(node -p "require('./node_modules/pdfjs-dist/package.json').version")" \
  && PARSE5_VERSION="$(node -p "require('./node_modules/parse5/package.json').version")" \
  && LINKEDOM_VERSION="$(node -p "require('./node_modules/linkedom/package.json').version")" \
  && READABILITY_VERSION="$(node -p "require('./node_modules/@mozilla/readability/package.json').version")" \
  && ACORN_VERSION="$(node -p "require('./node_modules/acorn/package.json').version")" \
  && POSTCSS_VERSION="$(node -p "require('./node_modules/postcss/package.json').version")" \
  && POSTCSS_VALUE_PARSER_VERSION="$(node -p "require('./node_modules/postcss-value-parser/package.json').version")" \
  && ZOD_VERSION="$(node -p "require('./node_modules/zod/package.json').version")" \
  && UNPDF_VERSION="$(node -p "require('./node_modules/unpdf/package.json').version")" \
  && MCP_CLIENT_VERSION="$(node -p "require('./node_modules/@modelcontextprotocol/client/package.json').version")" \
  && MCP_SDK_VERSION="$(node -p "require('./node_modules/@modelcontextprotocol/sdk/package.json').version")" \
  && MICROSANDBOX_VERSION="$(node -p "require('./node_modules/microsandbox/package.json').version")" \
  && MICROSANDBOX_MCP_VERSION="$(node -p "require('./node_modules/microsandbox-mcp/package.json').version")" \
  && SSH2_VERSION="$(node -p "require('./node_modules/ssh2/package.json').version")" \
  && PG_VERSION="$(node -p "require('./node_modules/pg/package.json').version")" \
  && YAML_VERSION="$(node -p "require('./node_modules/yaml/package.json').version")" \
  && XLSX_SPEC="$(node -p "require('./package.json').dependencies.xlsx")" \
  && npm pkg delete dependencies devDependencies \
  && npm pkg set \
    "dependencies.@napi-rs/canvas=$CANVAS_VERSION" \
    "dependencies.@aws-sdk/client-s3=$AWS_SDK_VERSION" \
    "dependencies.@aws-sdk/s3-request-presigner=$S3_PRESIGNER_VERSION" \
    "dependencies.@modelcontextprotocol/client=$MCP_CLIENT_VERSION" \
    "dependencies.@modelcontextprotocol/sdk=$MCP_SDK_VERSION" \
    "dependencies.@prisma/client=$PRISMA_CLIENT_VERSION" \
    "dependencies.pdf-lib=$PDF_LIB_VERSION" \
    "dependencies.pdfjs-dist=$PDFJS_VERSION" \
    "dependencies.parse5=$PARSE5_VERSION" \
    "dependencies.linkedom=$LINKEDOM_VERSION" \
    "dependencies.@mozilla/readability=$READABILITY_VERSION" \
    "dependencies.acorn=$ACORN_VERSION" \
    "dependencies.postcss=$POSTCSS_VERSION" \
    "dependencies.postcss-value-parser=$POSTCSS_VALUE_PARSER_VERSION" \
    "dependencies.zod=$ZOD_VERSION" \
    "dependencies.microsandbox=$MICROSANDBOX_VERSION" \
    "dependencies.microsandbox-mcp=$MICROSANDBOX_MCP_VERSION" \
    "dependencies.ssh2=$SSH2_VERSION" \
    "dependencies.pg=$PG_VERSION" \
    "dependencies.yaml=$YAML_VERSION" \
    "dependencies.prisma=$PRISMA_VERSION" \
    "dependencies.tsx=$TSX_VERSION" \
    "dependencies.sharp=$SHARP_VERSION" \
    "dependencies.unpdf=$UNPDF_VERSION" \
    "dependencies.xlsx=$XLSX_SPEC" \
  && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# One published image owns the standalone application, private Memory and PDF
# workers, and narrowly pruned installation tools. Compose selects the role by
# command.
FROM ${NODE_IMAGE} AS release

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=tools-deps /app/node_modules ./node_modules
COPY --chown=node:node . .
COPY --chown=node:node --from=runtime-build /app/.next/standalone ./runtime
COPY --chown=node:node --from=runtime-build /app/.next/static ./runtime/.next/static
COPY --chown=node:node --from=runtime-build /app/public ./runtime/public

USER node

RUN node scripts/verify-release-vision.cjs
RUN node scripts/verify-release-isolated-parser.cjs

EXPOSE 3000

CMD ["node", "scripts/runtime-launcher.cjs", "runtime/server.js"]

# The microVM guest contains general-purpose document/code tooling only. No
# AIQSA source tree, application dependency graph, or installation secret is
# copied into this stage; only the standard-library MCP client below.
FROM ${NODE_IMAGE} AS workspace-guest

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/opt/aiqsa-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/aiqsa-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash binutils build-essential ca-certificates coreutils curl ffmpeg file git \
    fonts-noto-core imagemagick jq libmagic1 libreoffice openssh-client p7zip-full \
    pkg-config poppler-utils procps python3 python3-dev python3-pip python3-venv \
    ripgrep sqlite3 tar unzip wget xz-utils xxd zip \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/aiqsa-python \
  && /opt/aiqsa-python/bin/pip install --disable-pip-version-check --no-cache-dir \
    Pillow==11.3.0 lxml==6.0.1 matplotlib==3.10.6 openpyxl==3.1.5 \
    pandas==2.3.2 pdfplumber==0.11.7 pyarrow==21.0.0 pypdf==6.0.0 \
    python-docx==1.2.0 python-pptx==1.0.2 uv==0.8.15 playwright==1.60.0 pyotp==2.10.0 \
  && /opt/aiqsa-python/bin/pip install --disable-pip-version-check --no-cache-dir psd-tools==1.19.0 \
  && /opt/aiqsa-python/bin/pip check \
  && /opt/aiqsa-python/bin/playwright install --with-deps --only-shell chromium \
  && apt-get purge -y xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --ignore-scripts --no-audit --no-fund pnpm@10.15.1 \
  && mkdir -p /workspace/inbox/messages /workspace/project /workspace/output /workspace/tmp \
  && chmod 0755 /workspace /workspace/inbox /workspace/inbox/messages \
    /workspace/project /workspace/output /workspace/tmp

RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.160.0 \
  && codex --version

# Bundles a multi-module web page into one self-contained ES module for an
# artifact, offline too. `--ignore-scripts` skips only the postinstall binary
# shortcut: the JS launcher runs the native binary from the optional
# @esbuild/linux-<arch> package npm selects for the build architecture.
RUN npm install --global --ignore-scripts --no-audit --no-fund esbuild@0.28.1 \
  && esbuild --version

# Guest code calls the run's MCP tools through `import aiqsa` or `aiqsa-mcp`.
# The package uses the standard library only; PYTHONPATH (the guest gets it
# from the OCI config) reaches other interpreters such as `uv run` scripts.
ENV PYTHONPATH=/opt/aiqsa-guest/python
COPY ops/workspace-guest/python/aiqsa /opt/aiqsa-guest/python/aiqsa
COPY ops/workspace-guest/bin/aiqsa-mcp /usr/local/bin/aiqsa-mcp
RUN chmod 0755 /usr/local/bin/aiqsa-mcp \
  && chmod -R u=rwX,go=rX /opt/aiqsa-guest \
  && echo /opt/aiqsa-guest/python > "$(/opt/aiqsa-python/bin/python3 -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')/aiqsa-guest.pth" \
  && /opt/aiqsa-python/bin/python3 -I -c 'import aiqsa.cli, aiqsa.mcp; print("aiqsa", aiqsa.__version__)' \
  && aiqsa-mcp --version \
  && (aiqsa-mcp list; test $? -eq 3)

WORKDIR /workspace/project

FROM ${NODE_IMAGE} AS workspace-image-layout

ARG TARGETARCH

WORKDIR /build
RUN apt-get update \
  && apt-get install -y --no-install-recommends gzip tar \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/build-workspace-oci.mjs ./build-workspace-oci.mjs
COPY --from=workspace-guest / /workspace-rootfs/
RUN node ./build-workspace-oci.mjs \
  /workspace-rootfs /workspace-image.oci.tar aiqsa-workspace:0.1.33 "$TARGETARCH"

# KVM-capable runtime role. Compose grants /dev/kvm and a writable MSB_HOME;
# the root filesystem itself remains read-only.
FROM release AS workspace-runner

USER root
ENV AIQSA_WORKSPACE_IMAGE_ARCHIVE=/opt/aiqsa/workspace-image.oci.tar
ENV MSB_HOME=/var/lib/microsandbox
RUN mkdir -p /var/lib/microsandbox /opt/aiqsa \
  && chown node:node /var/lib/microsandbox
COPY --from=workspace-image-layout /workspace-image.oci.tar /opt/aiqsa/workspace-image.oci.tar
USER node

EXPOSE 4310
CMD ["npm", "run", "workspace:runner"]

# Preserve the ordinary application image as the default Docker build result.
# The KVM role is selected explicitly with --target workspace-runner.
FROM release AS final
