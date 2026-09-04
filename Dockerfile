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

ARG AIQSA_BUILD_NODE_OPTIONS=""
ARG AIQSA_BUILD_APP_BASE_URL="https://build.invalid"

COPY . .
RUN AIQSA_APP_BASE_URL="$AIQSA_BUILD_APP_BASE_URL" \
  NODE_OPTIONS="$AIQSA_BUILD_NODE_OPTIONS" npm run build

# Retain the direct installation-tool and isolated PDF-worker roots and let npm
# preserve their complete locked transitive closure. Deriving versions from the
# npm-ci result keeps package-lock.json authoritative without naming transitive
# packages.
FROM runtime-deps AS tools-deps

RUN PRISMA_VERSION="$(node -p "require('./node_modules/prisma/package.json').version")" \
  && PRISMA_CLIENT_VERSION="$(node -p "require('./node_modules/@prisma/client/package.json').version")" \
  && AWS_SDK_VERSION="$(node -p "require('./node_modules/@aws-sdk/client-s3/package.json').version")" \
  && TSX_VERSION="$(node -p "require('./node_modules/tsx/package.json').version")" \
  && CANVAS_VERSION="$(node -p "require('./node_modules/@napi-rs/canvas/package.json').version")" \
  && PDF_LIB_VERSION="$(node -p "require('./node_modules/pdf-lib/package.json').version")" \
  && UNPDF_VERSION="$(node -p "require('./node_modules/unpdf/package.json').version")" \
  && MCP_SDK_VERSION="$(node -p "require('./node_modules/@modelcontextprotocol/sdk/package.json').version")" \
  && MICROSANDBOX_VERSION="$(node -p "require('./node_modules/microsandbox/package.json').version")" \
  && MICROSANDBOX_MCP_VERSION="$(node -p "require('./node_modules/microsandbox-mcp/package.json').version")" \
  && npm pkg delete dependencies devDependencies overrides \
  && npm pkg set \
    "dependencies.@napi-rs/canvas=$CANVAS_VERSION" \
    "dependencies.@aws-sdk/client-s3=$AWS_SDK_VERSION" \
    "dependencies.@modelcontextprotocol/sdk=$MCP_SDK_VERSION" \
    "dependencies.@prisma/client=$PRISMA_CLIENT_VERSION" \
    "dependencies.pdf-lib=$PDF_LIB_VERSION" \
    "dependencies.microsandbox=$MICROSANDBOX_VERSION" \
    "dependencies.microsandbox-mcp=$MICROSANDBOX_MCP_VERSION" \
    "dependencies.prisma=$PRISMA_VERSION" \
    "dependencies.tsx=$TSX_VERSION" \
    "dependencies.unpdf=$UNPDF_VERSION" \
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

EXPOSE 3000

CMD ["node", "scripts/runtime-launcher.cjs", "runtime/server.js"]

# The microVM guest contains general-purpose document/code tooling only. No
# AIQSA source tree, application dependency graph, or installation secret is
# copied into this stage.
FROM ${NODE_IMAGE} AS workspace-guest

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/opt/aiqsa-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash binutils build-essential ca-certificates coreutils curl ffmpeg file git \
    imagemagick jq libmagic1 libreoffice p7zip-full \
    pkg-config poppler-utils python3 python3-dev python3-pip python3-venv \
    ripgrep sqlite3 tar unzip wget xz-utils xxd zip \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/aiqsa-python \
  && /opt/aiqsa-python/bin/pip install --disable-pip-version-check --no-cache-dir \
    Pillow==11.3.0 lxml==6.0.1 matplotlib==3.10.6 openpyxl==3.1.5 \
    pandas==2.3.2 pdfplumber==0.11.7 pyarrow==21.0.0 pypdf==6.0.0 \
    python-docx==1.2.0 python-pptx==1.0.2 uv==0.8.15 \
  && npm install --global --ignore-scripts --no-audit --no-fund pnpm@10.15.1 \
  && mkdir -p /workspace/inbox/messages /workspace/project /workspace/output /workspace/tmp \
  && chmod 0755 /workspace /workspace/inbox /workspace/inbox/messages \
    /workspace/project /workspace/output /workspace/tmp

WORKDIR /workspace/project

FROM ${NODE_IMAGE} AS workspace-image-layout

ARG TARGETARCH=amd64

WORKDIR /build
RUN apt-get update \
  && apt-get install -y --no-install-recommends gzip tar \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/build-workspace-oci.mjs ./build-workspace-oci.mjs
COPY --from=workspace-guest / /workspace-rootfs/
RUN node ./build-workspace-oci.mjs \
  /workspace-rootfs /workspace-image.oci.tar aiqsa-workspace:0.1.25 "$TARGETARCH"

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
