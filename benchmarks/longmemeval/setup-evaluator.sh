#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
upstream_dir="${script_dir}/.upstream"
python_dir="${upstream_dir}/.venv"

verify_file() {
  local path="$1"
  local expected="$2"
  printf '%s  %s\n' "${expected}" "${path}" | sha256sum --check --status
}

test "$(git -C "${upstream_dir}" rev-parse HEAD)" = \
  "9e0b455f4ef0e2ab8f2e582289761153549043fc"
test -z "$(git -C "${upstream_dir}" status --short --untracked-files=no)"
verify_file \
  "${upstream_dir}/requirements-lite.txt" \
  "d9d66e3c70fa859855f0fb47f3b3ee39b881d599e27f9b10ba725c7796a9d14b"
verify_file \
  "${upstream_dir}/src/evaluation/evaluate_qa.py" \
  "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251"

if ! test -x "${python_dir}/bin/python"; then
  python3 -m venv "${python_dir}"
fi

"${python_dir}/bin/python" -m pip install \
  --disable-pip-version-check \
  --requirement "${upstream_dir}/requirements-lite.txt" \
  "httpx==0.27.2"

"${python_dir}/bin/python" -c \
  'import backoff, httpx, numpy, openai, tqdm; assert httpx.__version__ == "0.27.2"'

printf 'LongMemEval evaluator environment is ready.\n'
