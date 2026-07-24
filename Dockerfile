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

COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=runtime-build /app/.next/standalone ./
COPY --chown=node:node --from=runtime-build /app/.next/static ./.next/static
COPY --chown=node:node --from=runtime-build /app/public ./public

USER node

EXPOSE 3000

CMD ["node", "server.js"]

# Retain only the four direct tools roots and let npm preserve their complete
# locked transitive closure. Deriving their versions from the npm-ci result
# keeps package-lock.json authoritative without naming transitive packages.
FROM runtime-deps AS tools-deps

RUN PRISMA_VERSION="$(node -p "require('./node_modules/prisma/package.json').version")" \
  && PRISMA_CLIENT_VERSION="$(node -p "require('./node_modules/@prisma/client/package.json').version")" \
  && AWS_SDK_VERSION="$(node -p "require('./node_modules/@aws-sdk/client-s3/package.json').version")" \
  && TSX_VERSION="$(node -p "require('./node_modules/tsx/package.json').version")" \
  && npm pkg delete dependencies devDependencies overrides \
  && npm pkg set \
    "dependencies.@aws-sdk/client-s3=$AWS_SDK_VERSION" \
    "dependencies.@prisma/client=$PRISMA_CLIENT_VERSION" \
    "dependencies.prisma=$PRISMA_VERSION" \
    "dependencies.tsx=$TSX_VERSION" \
  && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# Prisma migrations and the installation bootstrap deliberately live outside the
# long-running application image. Copying the pruned tree into a clean stage
# prevents deleted build dependencies from remaining in lower image layers.
FROM ${NODE_IMAGE} AS tools

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=tools-deps /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

CMD ["sh", "-c", "npm run db:migrate:deploy && npm run db:cutover && npm run db:bootstrap"]
