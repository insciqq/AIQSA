#!/usr/bin/env bash
set -euo pipefail

# Downloads the pinned public Knowledge benchmark datasets into the ignored
# local benchmarks/knowledge/.data/ directory and verifies every file by
# SHA-256. No dataset content is ever committed. The pins below must stay in
# lockstep with upstream.json; the runtime manifest decoder re-validates the
# same values and refuses placeholders.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
manifest_path="${script_dir}/upstream.json"
datasets_dir="${script_dir}/.data/datasets"

rus_scifact_revision="75b33d32f2f13f058d0598d6d78f0c3d3afc03d9"
rus_scifact_qrels_revision="5e0c312c9fb7304a2dc91ec7fd648b3ace5c329f"
t2_ragbench_revision="adf7fe1541ac37351ce1142544d8e3b43010ed92"

corpus_sha256="3f8e4a7bd5196ce0d067e109378786fd5c56f16ddba0c2d242c72885c989b473"
queries_sha256="f3e2f55f638c393e8f44ddf38e1e697e5273c3dea1c048a3b3a067ab4180c462"
qrels_test_sha256="0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c"
convfinqa_turn0_sha256="31dc9aa01a24eb27d082445c08c976580239311a305be6542b23059763cd9206"

if grep -q "PIN_ME" "${manifest_path}"; then
  printf 'upstream.json still contains PIN_ME placeholders; refusing to download.\n' >&2
  exit 1
fi
for pin in \
  "${rus_scifact_revision}" "${rus_scifact_qrels_revision}" "${t2_ragbench_revision}" \
  "${corpus_sha256}" "${queries_sha256}" "${qrels_test_sha256}" "${convfinqa_turn0_sha256}"; do
  if ! printf '%s' "${pin}" | grep -Eq '^[0-9a-f]{40}$|^[0-9a-f]{64}$'; then
    printf 'Pinned value %s is not a hex revision/checksum; refusing to download.\n' "${pin}" >&2
    exit 1
  fi
done

verify_file() {
  local path="$1"
  local expected="$2"
  printf '%s  %s\n' "${expected}" "${path}" | sha256sum --check --status
}

verify_all() {
  verify_file "${datasets_dir}/rus-scifact/corpus.jsonl" "${corpus_sha256}"
  verify_file "${datasets_dir}/rus-scifact/queries.jsonl" "${queries_sha256}"
  verify_file "${datasets_dir}/rus-scifact/qrels-test.tsv" "${qrels_test_sha256}"
  verify_file "${datasets_dir}/convfinqa/turn_0.jsonl" "${convfinqa_turn0_sha256}"
}

if test -e "${datasets_dir}"; then
  verify_all
  printf 'Knowledge benchmark datasets are already downloaded and verified.\n'
  exit 0
fi

temporary_root="$(mktemp -d "${script_dir}/.download.XXXXXX")"
trap 'rm -rf -- "${temporary_root}"' EXIT

fetch() {
  local url="$1"
  local output="$2"
  curl --fail --location --silent --show-error "${url}" --output "${output}"
}

mkdir -p "${temporary_root}/datasets/rus-scifact" "${temporary_root}/datasets/convfinqa"
fetch "https://huggingface.co/datasets/kaengreg/rus-scifact/resolve/${rus_scifact_revision}/corpus.jsonl" \
  "${temporary_root}/datasets/rus-scifact/corpus.jsonl"
fetch "https://huggingface.co/datasets/kaengreg/rus-scifact/resolve/${rus_scifact_revision}/queries.jsonl" \
  "${temporary_root}/datasets/rus-scifact/queries.jsonl"
fetch "https://huggingface.co/datasets/kaengreg/rus-scifact-qrels/resolve/${rus_scifact_qrels_revision}/test.tsv" \
  "${temporary_root}/datasets/rus-scifact/qrels-test.tsv"
fetch "https://huggingface.co/datasets/G4KMU/t2-ragbench/resolve/${t2_ragbench_revision}/data/ConvFinQA/turn_0.jsonl" \
  "${temporary_root}/datasets/convfinqa/turn_0.jsonl"

mkdir -p "${script_dir}/.data"
mv "${temporary_root}/datasets" "${datasets_dir}"
verify_all
printf 'Downloaded and verified the pinned Knowledge benchmark datasets.\n'
