#!/usr/bin/env python3
"""Offline synthetic package smoke; run inside the built Workspace guest.

python scripts/smoke-workspace-psd.py [--output-directory <new-directory>]
The optional directory retains synthetic PSD/PNG fixtures for integration checks.
Host execution checks the fixture only; it is not guest/KVM qualification.
"""

import argparse
import io
import json
import os
from pathlib import Path
import resource
import signal
import struct
import sys
import tempfile
import warnings

# Bound the verifier itself, including imports and malformed-input handling.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
MEMORY_BYTES = 768 * 1024 * 1024
DECODE_BYTES = 16 * 1024 * 1024
resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
signal.alarm(30)


def deny_network(event, _args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.bind"}:
        raise RuntimeError("psd_smoke_network_forbidden")


sys.addaudithook(deny_network)

from importlib.metadata import version  # noqa: E402
from PIL import Image  # noqa: E402
from psd_tools import PSDImage  # noqa: E402
from psd_tools.compression import PSDDecompressionWarning  # noqa: E402

warnings.simplefilter("error", Image.DecompressionBombWarning)
warnings.simplefilter("error", PSDDecompressionWarning)


def require(condition, code):
    if not condition:
        raise AssertionError(code)


def require_same_pixels(actual, expected, code):
    require(actual is not None and actual.size == expected.size, code + "_size")
    require(actual.convert("RGBA").tobytes() == expected.convert("RGBA").tobytes(), code + "_pixels")


def inspect(psd, originals):
    require(psd.size == (16, 16), "canvas")
    require(len(psd) == 4 and len(list(psd.descendants())) == 5, "structure")
    paths = ((0,), (1,), (2,), (3, 0))
    offsets = ((2, 3), (8, 2), (1, 10), (12, 9))
    names = ("Слой 🌊", "Слой 🌊", "Hidden", "Child")
    visible = (True, True, False, True)
    for path, offset, name, flag, original in zip(paths, offsets, names, visible, originals):
        layer = psd[path[0]] if len(path) == 1 else psd[path[0]][path[1]]
        require(layer.kind == "pixel" and layer.name == name, "layer_identity")
        require(layer.offset == offset and layer.visible == flag, "layer_offset_visibility")
        require(layer.bbox == (*offset, offset[0] + original.width, offset[1] + original.height), "layer_bbox")
        require_same_pixels(layer.topil(), original, "raster_roundtrip")
    require(psd[3].is_group() and psd[3].name == "Группа" and not psd[3].visible, "hidden_group")
    require(not psd[3][0].is_visible(), "inherited_visibility")
    require(psd[0].has_mask() and psd[0].mask.bbox == (2, 3, 6, 6), "mask_geometry")
    require(psd[0].mask.topil().tobytes() == bytes([0, 0, 255, 255] * 3), "mask_pixels")


def check_preview(image):
    rgba = image.convert("RGBA")
    require(rgba.size == (16, 16), "preview_canvas")
    for y in range(16):
        for x in range(16):
            if 4 <= x < 6 and 3 <= y < 6:
                expected = (255, 0, 0, 128 if (x, y) == (4, 4) else 255)
            elif 8 <= x < 11 and 2 <= y < 6:
                expected = (0, 0, 255, 128)
            else:
                require(rgba.getpixel((x, y))[3] == 0, "preview_hidden_or_masked")
                continue
            require(all(abs(a - b) <= 1 for a, b in zip(rgba.getpixel((x, y)), expected)), "preview_rgba")


def rejected_inputs(valid_path):
    try:
        PSDImage.open(io.BytesIO(b"not a PSD document"), max_alloc_bytes=DECODE_BYTES)
    except (ValueError, OSError):
        pass
    else:
        raise AssertionError("malformed_accepted")

    # Tiny, self-generated header with oversized decoded geometry, no exploit bytes.
    header = struct.pack(">4sH6sHIIHH", b"8BPS", 1, b"\0" * 6, 3, 2048, 2048, 8, 3)
    oversized = PSDImage.open(io.BytesIO(header + b"\0" * 14), max_alloc_bytes=1024 * 1024)
    for operation in (oversized.topil, oversized.numpy, lambda: oversized.composite(ignore_preview=True)):
        try:
            operation()
        except ValueError as error:
            require("budget" in str(error).lower(), "decoded_guard_reason")
        else:
            raise AssertionError("oversized_decode_accepted")

    bounded = PSDImage.open(valid_path, max_alloc_bytes=1)
    try:
        bounded.composite(ignore_preview=True)
    except ValueError as error:
        require("budget" in str(error).lower(), "allocation_guard_reason")
    else:
        raise AssertionError("allocation_limit_ignored")
    require(Image.MAX_IMAGE_PIXELS is not None and Image.MAX_IMAGE_PIXELS > 0, "pillow_guard_disabled")


def run(directory):
    require(version("psd-tools") == "1.19.0", "package_pin")
    originals = [Image.new("RGBA", size, color) for size, color in (
        ((4, 3), (255, 0, 0, 255)), ((3, 4), (0, 0, 255, 128)),
        ((2, 2), (0, 255, 0, 255)), ((2, 2), (255, 255, 0, 64)))]
    originals[0].putpixel((0, 0), (255, 0, 0, 64))
    originals[0].putpixel((2, 1), (255, 0, 0, 128))
    psd = PSDImage.new("RGBA", (16, 16))
    for index, (original, offset, name) in enumerate(zip(originals, ((2, 3), (8, 2), (1, 10), (12, 9)),
            ("Слой 🌊", "Слой 🌊", "Hidden", "Child"))):
        png = directory / f"input-{index}.png"
        original.save(png)
        with Image.open(png) as source:
            layer = psd.create_pixel_layer(source, name="Layer", left=offset[0], top=offset[1])
            layer.name = name
    psd[2].visible = False
    group = psd.create_group(name="Group", layer_list=[psd[3]])
    # The public setter writes the Unicode name and safe legacy Pascal name.
    group.name = "Группа"
    group.visible = False
    mask = Image.new("L", (4, 3))
    mask.putdata([0, 0, 255, 255] * 3)
    psd[0].create_mask(mask)
    fixture = directory / "synthetic.psd"
    psd.save(fixture)
    reopened = PSDImage.open(fixture, max_alloc_bytes=DECODE_BYTES)
    inspect(reopened, originals)
    exported = directory / "selected-layer.png"
    reopened[1].topil().save(exported)
    with Image.open(exported) as extracted:
        require_same_pixels(extracted, originals[1], "png_extraction")
    require(reopened.has_preview(), "cached_preview_missing")
    cached = reopened.topil()
    # A merged preview can omit alpha even though the raster records retain it.
    require(cached is not None and cached.size == (16, 16), "cached_preview_canvas")
    require(cached.convert("RGB").getpixel((4, 3)) == (255, 0, 0), "cached_preview_red")
    require(cached.convert("RGB").getpixel((8, 2)) == (0, 0, 255), "cached_preview_blue")
    cached.save(directory / "cached-preview.png")
    recomposed = reopened.composite(ignore_preview=True)
    check_preview(recomposed)
    recomposed.save(directory / "recomposed-preview.png")
    # Basic save/reopen preserves the qualified raster records, including hidden ones.
    saved = directory / "roundtrip.psd"
    reopened.save(saved)
    inspect(PSDImage.open(saved, max_alloc_bytes=DECODE_BYTES), originals)
    rejected_inputs(fixture)
    evidence = {
        "ok": True, "psd_tools": version("psd-tools"), "pillow": version("Pillow"), "numpy": version("numpy"),
        "raster_layers": 4, "groups": 1, "cached_preview": True, "recomposed_preview": True,
        "cached_preview_mode": cached.mode, "recomposed_preview_mode": recomposed.mode,
        "mask_alpha_geometry": True, "save_reopen": True, "malformed_rejected": True,
        "decoded_allocation_guard": True, "pillow_guard": True, "network_forbidden": True,
        "memory_limit_bytes": MEMORY_BYTES, "cpu_limit_seconds": 20, "wall_limit_seconds": 30,
        "limitations": ["raster_roundtrip_only", "advanced_photoshop_features_unqualified", "spine_runtime_unqualified"]
    }
    (directory / "evidence.json").write_text(json.dumps(evidence) + "\n")
    print(json.dumps(evidence))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path)
    args = parser.parse_args()
    if args.output_directory:
        args.output_directory.mkdir(mode=0o700, parents=False, exist_ok=False)
        run(args.output_directory)
    else:
        with tempfile.TemporaryDirectory(prefix="aiqsa-psd-smoke-") as temporary:
            run(Path(temporary))
