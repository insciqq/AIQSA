"""Prepare the frozen FactConsolidation subset; never calls an answer provider."""
import ast
import hashlib
import json
import re
import string
import subprocess
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def upstream_functions(source, names, namespace):
    """Load only reviewed pure metric/chunking functions, without optional agents."""
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in nodes} != set(names):
        raise ValueError("factconsolidation_upstream_functions_missing")
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "pinned_upstream", "exec"), namespace)
    return namespace


def main():
    import nltk
    import pyarrow.parquet as parquet
    import tiktoken

    manifest = json.loads((ROOT / "upstream.json").read_text())
    upstream = ROOT / ".upstream"
    commit = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
    if commit != manifest["repository"]["commit"]:
        raise ValueError("factconsolidation_upstream_revision_mismatch")
    for filename, expected in manifest["repository"]["files"].items():
        if sha256((upstream / filename).read_bytes()) != expected:
            raise ValueError("factconsolidation_upstream_hash_mismatch")
    dataset = ROOT / ".data/Conflict_Resolution.parquet"
    if sha256(dataset.read_bytes()) != manifest["dataset"]["sha256"]:
        raise ValueError("factconsolidation_dataset_hash_mismatch")
    resources = ROOT / ".data/nltk"
    nltk.data.path.insert(0, str(resources))
    if not (resources / "tokenizers/punkt_tab/english").is_dir():
        if not nltk.download("punkt_tab", download_dir=str(resources), quiet=True):
            raise ValueError("factconsolidation_tokenizer_download_failed")
    metric_source = (upstream / "utils/eval_other_utils.py").read_text()
    functions = upstream_functions(metric_source,
        {"normalize_answer", "substring_exact_match_score", "parse_output", "chunk_text_into_sentences"},
        {"re": re, "string": string, "tiktoken": tiktoken,
         "nltk": SimpleNamespace(download=lambda *args, **kwargs: None, sent_tokenize=nltk.sent_tokenize)})
    # Evaluate only literal template assignments; do not import agent implementations.
    template_nodes = ast.parse((upstream / "utils/templates.py").read_text()).body
    assignments = [node for node in template_nodes if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id in {"SYSTEM_MESSAGE", "BASE_TEMPLATES"}
                           for target in node.targets)]
    templates = {}
    exec(compile(ast.Module(body=assignments, type_ignores=[]), "pinned_templates", "exec"), templates)
    query_template = templates["BASE_TEMPLATES"]["factconsolidation"]["query"]["rag_agent"]
    selected = []
    contexts = {}
    for row in parquet.read_table(dataset).to_pylist():
        source = row["metadata"]["source"]
        if source not in manifest["selection"]["sources"]:
            continue
        identifiers = row["metadata"]["qa_pair_ids"]
        if len(identifiers) != len(row["questions"]) or len(identifiers) != len(row["answers"]):
            raise ValueError("factconsolidation_question_identity_mismatch")
        seed = manifest["selection"]["seed"]
        indices = sorted(sorted(range(len(identifiers)), key=lambda index:
            sha256((seed + "\0" + identifiers[index]).encode()))[:manifest["selection"]["questionsPerStratum"]])
        context_hash = sha256(row["context"].encode())
        if context_hash not in contexts:
            chunks = functions["chunk_text_into_sentences"](row["context"], chunk_size=manifest["selection"]["chunkTokens"])
            if not chunks or any(not chunk.strip() for chunk in chunks):
                raise ValueError("factconsolidation_chunks_invalid")
            # Only whitespace between sentences may change in upstream chunking.
            if row["context"].split() != " ".join(chunks).split():
                raise ValueError("factconsolidation_chunk_content_changed")
            contexts[context_hash] = {"context": row["context"], "chunks": chunks,
                "chunkHashes": [sha256(chunk.encode()) for chunk in chunks]}
        selected.append({"source": source, "contextSha256": context_hash, "questions": [
            {"id": identifiers[index], "question": row["questions"][index],
             "query": query_template.format(question=row["questions"][index]), "answers": row["answers"][index]}
            for index in indices]})
    if len(selected) != len(manifest["selection"]["sources"]):
        raise ValueError("factconsolidation_stratum_missing")
    resource_files = sorted((resources / "tokenizers/punkt_tab/english").glob("*"))
    artifact = {"version": 1, "upstream": manifest, "contexts": contexts, "strata": selected,
        "memorizeTemplate": templates["BASE_TEMPLATES"]["factconsolidation"]["memorize"],
        "tokenizerResources": {path.name: sha256(path.read_bytes()) for path in resource_files},
        "queryTemplateSha256": sha256(query_template.encode())}
    destination = ROOT / ".data/prepared.json"
    encoded = (json.dumps(artifact, ensure_ascii=False, indent=2) + "\n").encode()
    destination.write_bytes(encoded)
    destination.chmod(0o600)
    print(json.dumps({"preparedSha256": sha256(encoded), "contexts": len(contexts),
        "chunks": sum(len(context["chunks"]) for context in contexts.values()),
        "questions": sum(len(row["questions"]) for row in selected)}))


if __name__ == "__main__":
    main()
