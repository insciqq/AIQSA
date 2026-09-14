"""Use the pinned upstream rubric without importing or invoking its providers."""
import ast
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EVALUATOR_SHA = "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251"
ORACLE_SHA = "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c"


def checked(path, digest):
    value = path.read_bytes()
    if hashlib.sha256(value).hexdigest() != digest:
        raise ValueError("longmemeval_sol_evaluator_integrity_failed")
    return value


def main():
    source = checked(ROOT / ".upstream/src/evaluation/evaluate_qa.py", EVALUATOR_SHA)
    reference = checked(ROOT / ".upstream/data/longmemeval_oracle.json", ORACLE_SHA)
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, ast.FunctionDef) and node.name == "get_anscheck_prompt"]
    if len(nodes) != 1:
        raise ValueError("longmemeval_sol_rubric_missing")
    namespace = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "pinned_longmemeval_rubric", "exec"), namespace)
    rubric = namespace["get_anscheck_prompt"]
    oracle = {row["question_id"]: row for row in json.loads(reference)}
    rows = json.load(sys.stdin)
    if len({row["question_id"] for row in rows}) != len(rows):
        raise ValueError("longmemeval_sol_duplicate_question")
    result = []
    for row in rows:
        item = oracle[row["question_id"]]
        result.append({"id": row["question_id"], "type": item["question_type"],
            "prompt": rubric(item["question_type"], item["question"], item["answer"],
                             row["hypothesis"], abstention="_abs" in row["question_id"])})
    controls = [
        ("single-session-user", "Where do I live?", "York", "You live in York.", True),
        ("single-session-user", "Where do I live?", "York", "You live in Leeds.", False),
        ("multi-session", "Name both pets.", "Pip and Dot", "Pip", False),
        ("multi-session", "Name both pets.", "Pip and Dot", "Dot and Pip", True),
        ("knowledge-update", "Where do I live now?", "York", "Previously Leeds, now York.", True),
        ("knowledge-update", "Where do I live now?", "York", "Previously York, now Leeds.", False),
        ("temporal-reasoning", "How many days?", "18 days", "19 days", True),
        ("temporal-reasoning", "How many days?", "18 days", "28 days", False)
    ]
    json.dump({"rows": result, "controls": [{"expected": expected,
        "prompt": rubric(task, question, answer, response)}
        for task, question, answer, response, expected in controls]}, sys.stdout)


if __name__ == "__main__":
    main()
