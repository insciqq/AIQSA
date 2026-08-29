# syntax=docker/dockerfile:1.7

ARG POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff

FROM ${POSTGRES_IMAGE}

LABEL org.opencontainers.image.description="AIQSA PostgreSQL 18.6 Trixie runtime with pgvector 0.8.6" \
      org.opencontainers.image.licenses="PostgreSQL" \
      org.opencontainers.image.source="https://github.com/insciqq/AIQSA" \
      org.opencontainers.image.title="AIQSA PostgreSQL with pgvector" \
      org.opencontainers.image.version="postgres-18.6-pgvector-0.8.6"
