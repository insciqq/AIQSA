# aiqsa-connect

`aiqsa-connect` is the AIQSA Connect client. It runs on the user's own
computer (macOS, Linux or WSL), connects to that user's AIQSA installation and
lets them open terminal sessions on the computer from AIQSA in a browser.

The client is a separate Go module inside the AIQSA repository. AIQSA builds
and serves the binaries itself; nothing is published to a package registry.

## Layout

- `cmd/aiqsa-connect/` — the command. `main.go` holds a small command
  registry; each subcommand lives in its own `cmd_<name>.go` file and
  registers itself from `init()`. The version is stamped at build time with
  `-ldflags "-X main.version=<version>"` and is `dev` otherwise.
- `internal/protocol/` — Go types for the wire protocol. They mirror the
  TypeScript contract in `lib/contracts/connect.ts` (same names, JSON keys,
  limits, codes and patterns) and decode strictly: unknown keys, missing
  required keys and unexpected nulls are errors, and every message has
  `Validate()`.
- `internal/protocol/testdata/` — fixtures shared with
  `lib/contracts/connect.test.ts`:
  - `valid/<schema>.<case>.json` must be accepted by both suites, and
    `invalid/<schema>.<case>.json` rejected by both. `<schema>` is the part of
    the file name before the first dot and names a schema registered in both
    tests (`serverCommand`, `deviceEvent`, `deviceStreamEvent`, …). A fixture
    is one JSON value; an SSE event is `{"event": <name>, "data": <data>}`.
    Adding a fixture file needs no code change.
  - `contract.json` holds the limits, codes, patterns and paths; both suites
    compare their exported constants with it.
- `dist/` — locally built binaries (ignored by Git and Docker).

## Development

Go 1.27 (see `go.mod`). From this directory:

```bash
test -z "$(gofmt -l .)" && go vet ./... && go test ./...
go build -o dist/aiqsa-connect ./cmd/aiqsa-connect && dist/aiqsa-connect version
```

The TypeScript side of the shared fixtures runs with
`npx vitest run lib/contracts/connect.test.ts` from the repository root.
