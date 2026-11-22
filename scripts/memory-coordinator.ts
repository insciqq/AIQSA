// The previous entry point of the `memory-worker` service. An installation whose own Compose file still runs
// `node --import tsx scripts/memory-coordinator.ts` starts the same background worker as
// `scripts/background-worker.ts`; the repository's `compose.yaml` runs that file directly.
import "./background-worker";
