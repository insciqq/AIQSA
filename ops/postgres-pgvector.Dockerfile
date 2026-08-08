# syntax=docker/dockerfile:1.7

ARG POSTGRES_IMAGE=postgres:16.14-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229

FROM ${POSTGRES_IMAGE} AS pgvector-build

ARG PGVECTOR_VERSION=0.8.5
ARG PGVECTOR_SOURCE_SHA256=6f88a5cbdde31666f4b6c1a6b75c51dcbeffe58f9a7d2b26e502d5a6e5e14d44

RUN apk add --no-cache --virtual .pgvector-build-deps \
      build-base \
      ca-certificates \
      clang19 \
      curl \
      llvm19-dev

WORKDIR /tmp

RUN curl --fail --show-error --location --retry 3 \
      --output pgvector.tar.gz \
      "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
    && echo "${PGVECTOR_SOURCE_SHA256}  pgvector.tar.gz" | sha256sum -c - \
    && tar -xzf pgvector.tar.gz \
    && make -C "pgvector-${PGVECTOR_VERSION}" OPTFLAGS="" \
    && make -C "pgvector-${PGVECTOR_VERSION}" OPTFLAGS="" \
      DESTDIR=/opt/pgvector install \
    && install -d /opt/pgvector/usr/share/doc/pgvector \
    && install -m 0644 \
      "pgvector-${PGVECTOR_VERSION}/LICENSE" \
      "pgvector-${PGVECTOR_VERSION}/README.md" \
      /opt/pgvector/usr/share/doc/pgvector/

FROM ${POSTGRES_IMAGE}

ARG PGVECTOR_VERSION=0.8.5

LABEL org.opencontainers.image.description="AIQSA PostgreSQL 16 Alpine runtime with the pgvector extension artifacts installed" \
      org.opencontainers.image.licenses="PostgreSQL" \
      org.opencontainers.image.source="https://github.com/insciqq/AIQSA" \
      org.opencontainers.image.title="AIQSA PostgreSQL with pgvector" \
      org.opencontainers.image.version="postgres-16.14-pgvector-${PGVECTOR_VERSION}"

COPY --from=pgvector-build /opt/pgvector/usr/local/ /usr/local/
COPY --from=pgvector-build /opt/pgvector/usr/share/doc/pgvector/ /usr/share/doc/pgvector/
