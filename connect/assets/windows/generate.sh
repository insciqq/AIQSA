#!/bin/sh
# Regenerates the Windows resources of aiqsa-connect.exe: the program and
# tray icons (from public/icon-512.png), the version information and the
# manifest (asInvoker, PerMonitorV2, Windows 10 and later, common controls
# 6) in winres.json. The output, cmd/aiqsa-connect/rsrc_windows_amd64.syso
# and rsrc_windows_arm64.syso, is committed, so building the client stays a
# plain, deterministic `go build`; run this only after changing the icon or
# winres.json, and commit the result.
#
# It needs Go and the module proxy. go-winres runs pinned by version and
# checked against the Go checksum database; it is a generator only and
# never part of the client.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
connect=$(cd "$here/../.." && pwd)
repo=$(cd "$connect/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$connect"
go run ./assets/windows/genicons -src "$repo/public/icon-512.png" -out "$work"
cp "$here/winres.json" "$work/winres.json"
cd "$work"
go run github.com/tc-hib/go-winres@v0.3.3 make --in winres.json --arch amd64,arm64 --out "$connect/cmd/aiqsa-connect/rsrc"
echo "Wrote $connect/cmd/aiqsa-connect/rsrc_windows_amd64.syso and rsrc_windows_arm64.syso"
