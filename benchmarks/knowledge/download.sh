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
bright_revision="3066d29c9651a576c8aba4832d249807b181ecae"

corpus_sha256="3f8e4a7bd5196ce0d067e109378786fd5c56f16ddba0c2d242c72885c989b473"
queries_sha256="f3e2f55f638c393e8f44ddf38e1e697e5273c3dea1c048a3b3a067ab4180c462"
qrels_test_sha256="0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c"
convfinqa_turn0_sha256="31dc9aa01a24eb27d082445c08c976580239311a305be6542b23059763cd9206"
bright_documents_sha256="d54559692f925666c3c6b1d33a696a64ef324cf5aaeff9d6f4d11fba5cd5ac8b"
bright_examples_sha256="97d417ba449ef70c9c9ae2937e9df106654a2554ce1533b090cb64b998a077e1"

if grep -q "PIN_ME" "${manifest_path}"; then
  printf 'upstream.json still contains PIN_ME placeholders; refusing to download.\n' >&2
  exit 1
fi
for pin in \
  "${rus_scifact_revision}" "${rus_scifact_qrels_revision}" "${t2_ragbench_revision}" \
  "${bright_revision}" "${corpus_sha256}" "${queries_sha256}" \
  "${qrels_test_sha256}" "${convfinqa_turn0_sha256}" \
  "${bright_documents_sha256}" "${bright_examples_sha256}"; do
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
  verify_file "${datasets_dir}/bright-stackoverflow-50m/documents.parquet" \
    "${bright_documents_sha256}"
  verify_file "${datasets_dir}/bright-stackoverflow-50m/examples.parquet" \
    "${bright_examples_sha256}"
}

temporary_root="$(mktemp -d "${script_dir}/.download.XXXXXX")"
trap 'rm -rf -- "${temporary_root}"' EXIT

fetch() {
  local url="$1"
  local output="$2"
  curl --fail --location --silent --show-error "${url}" --output "${output}"
}

download_verified() {
  local url="$1"
  local output="$2"
  local expected="$3"
  if test -e "${output}"; then
    verify_file "${output}" "${expected}"
    return
  fi
  local temporary="${temporary_root}/$(basename -- "${output}")"
  fetch "${url}" "${temporary}"
  verify_file "${temporary}" "${expected}"
  mkdir -p "$(dirname -- "${output}")"
  mv "${temporary}" "${output}"
}

download_verified \
  "https://huggingface.co/datasets/kaengreg/rus-scifact/resolve/${rus_scifact_revision}/corpus.jsonl" \
  "${datasets_dir}/rus-scifact/corpus.jsonl" "${corpus_sha256}"
download_verified \
  "https://huggingface.co/datasets/kaengreg/rus-scifact/resolve/${rus_scifact_revision}/queries.jsonl" \
  "${datasets_dir}/rus-scifact/queries.jsonl" "${queries_sha256}"
download_verified \
  "https://huggingface.co/datasets/kaengreg/rus-scifact-qrels/resolve/${rus_scifact_qrels_revision}/test.tsv" \
  "${datasets_dir}/rus-scifact/qrels-test.tsv" "${qrels_test_sha256}"
download_verified \
  "https://huggingface.co/datasets/G4KMU/t2-ragbench/resolve/${t2_ragbench_revision}/data/ConvFinQA/turn_0.jsonl" \
  "${datasets_dir}/convfinqa/turn_0.jsonl" "${convfinqa_turn0_sha256}"
download_verified \
  "https://huggingface.co/datasets/xlangai/BRIGHT/resolve/${bright_revision}/documents/stackoverflow-00000-of-00001.parquet" \
  "${datasets_dir}/bright-stackoverflow-50m/documents.parquet" \
  "${bright_documents_sha256}"
download_verified \
  "https://huggingface.co/datasets/xlangai/BRIGHT/resolve/${bright_revision}/examples/stackoverflow-00000-of-00001.parquet" \
  "${datasets_dir}/bright-stackoverflow-50m/examples.parquet" \
  "${bright_examples_sha256}"

verify_all
printf 'Downloaded and verified the pinned Knowledge benchmark datasets.\n'
