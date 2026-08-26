#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${script_dir}/.upstream"
repository_url="https://github.com/xiaowu0162/LongMemEval.git"
repository_commit="9e0b455f4ef0e2ab8f2e582289761153549043fc"
dataset_revision="98d7416c24c778c2fee6e6f3006e7a073259d48f"
dataset_root="https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${dataset_revision}"

verify_file() {
  local path="$1"
  local expected="$2"
  printf '%s  %s\n' "${expected}" "${path}" | sha256sum --check --status
}

verify_checkout() {
  test "$(git -C "${target_dir}" rev-parse HEAD)" = "${repository_commit}"
  test -z "$(git -C "${target_dir}" status --short --untracked-files=no)"
  verify_file "${target_dir}/src/evaluation/evaluate_qa.py" "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251"
  verify_file "${target_dir}/requirements-lite.txt" "d9d66e3c70fa859855f0fb47f3b3ee39b881d599e27f9b10ba725c7796a9d14b"
  verify_file "${target_dir}/data/longmemeval_s_cleaned.json" "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"
  verify_file "${target_dir}/data/longmemeval_oracle.json" "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c"
}

if test -d "${target_dir}/.git"; then
  verify_checkout
  printf 'LongMemEval upstream is already verified at %s.\n' "${repository_commit}"
  exit 0
fi

if test -e "${target_dir}"; then
  printf 'Refusing to replace unexpected path: %s\n' "${target_dir}" >&2
  exit 1
fi

temporary_root="$(mktemp -d "${script_dir}/.download.XXXXXX")"
trap 'rm -rf -- "${temporary_root}"' EXIT

git clone --filter=blob:none --no-checkout "${repository_url}" "${temporary_root}/upstream"
git -C "${temporary_root}/upstream" checkout --detach "${repository_commit}"
mkdir -p "${temporary_root}/upstream/data"
curl --fail --location --silent --show-error \
  "${dataset_root}/longmemeval_s_cleaned.json" \
  --output "${temporary_root}/upstream/data/longmemeval_s_cleaned.json"
curl --fail --location --silent --show-error \
  "${dataset_root}/longmemeval_oracle.json" \
  --output "${temporary_root}/upstream/data/longmemeval_oracle.json"
mv "${temporary_root}/upstream" "${target_dir}"
verify_checkout
printf 'Downloaded and verified LongMemEval at %s.\n' "${repository_commit}"
