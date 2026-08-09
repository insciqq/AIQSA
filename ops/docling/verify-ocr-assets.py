#!/usr/bin/env python3
"""Fail-closed build/runtime proof for AIQSA's offline Docling OCR assets."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path

from easyocr import Reader
from easyocr.config import detection_models, recognition_models


MODEL_DIRECTORY = Path("/opt/app-root/src/.cache/docling/models/EasyOcr")
EXPECTED_PACKAGE_VERSIONS = {
    "docling": "2.96.1",
    "docling-serve": "1.21.0",
    "easyocr": "1.7.2",
}
EXPECTED_MODELS = {
    "craft_mlt_25k.pth": "4a5efbfb48b4081100544e75e1e2b57f8de3d84f213004b14b85fd4b3748db17",
    "cyrillic_g2.pth": "48d0f3b58f28aa64651ab1032cc2d498c4de25135829668e87c14e7a07529f29",
}
EXPECTED_PUBLISHED_MODEL_MD5 = {
    "craft_mlt_25k.pth": "2f8227d2def4037cdb3b34389dcf9ec1",
    "cyrillic_g2.pth": "19f85f43d9128a89ac21b8d6a06973fe",
}


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def published_md5(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(
            stream,
            lambda: hashlib.md5(usedforsecurity=False),
        ).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    artifacts_directory = os.environ.get("DOCLING_SERVE_ARTIFACTS_PATH")
    require(
        artifacts_directory is not None
        and Path(artifacts_directory) / "EasyOcr" == MODEL_DIRECTORY,
        "Docling artifacts path does not select the sealed EasyOCR directory",
    )
    versions = {
        package: importlib.metadata.version(package)
        for package in EXPECTED_PACKAGE_VERSIONS
    }
    require(versions == EXPECTED_PACKAGE_VERSIONS, "unexpected parser package version")

    require(
        detection_models["craft"]["md5sum"] == "2f8227d2def4037cdb3b34389dcf9ec1",
        "unexpected EasyOCR CRAFT model metadata",
    )
    require(
        recognition_models["gen2"]["cyrillic_g2"]["md5sum"]
        == "19f85f43d9128a89ac21b8d6a06973fe",
        "unexpected EasyOCR Cyrillic model metadata",
    )

    for name, expected_hash in EXPECTED_MODELS.items():
        path = MODEL_DIRECTORY / name
        require(path.is_file(), f"missing OCR model: {name}")
        require(sha256(path) == expected_hash, f"unexpected OCR model digest: {name}")
        require(
            published_md5(path) == EXPECTED_PUBLISHED_MODEL_MD5[name],
            f"OCR model does not match EasyOCR's published checksum: {name}",
        )

    # Docling passes its artifacts directory to EasyOCR, which disables model
    # downloads. Constructing the exact ru/en reader proves that the sealed
    # image can resolve its detector and Cyrillic recognizer locally.
    reader = Reader(
        ["ru", "en"],
        download_enabled=False,
        gpu=False,
        model_storage_directory=str(MODEL_DIRECTORY),
        verbose=False,
    )
    require(reader.model_lang == "cyrillic", "ru/en did not select cyrillic_g2")

    print(
        json.dumps(
            {
                "languages": ["ru", "en"],
                "modelCount": len(EXPECTED_MODELS),
                "offlineReaderReady": True,
                "versions": versions,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
