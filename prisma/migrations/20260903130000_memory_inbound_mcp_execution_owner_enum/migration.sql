-- PostgreSQL requires a newly added enum value to commit before later DDL can
-- use it in predicates or constraints.
ALTER TYPE "MemoryExecutionOwnerType"
  ADD VALUE 'INBOUND_MCP_REQUEST';
