"""Run only a Cargo-emitted native unit-test executable with Common Controls v6.

Usage:
  In an x64 Visual Studio developer shell at the app source root:
  cargo test -p dmelopers-block-pet --lib --no-run --message-format=json > target/native-tests.jsonl
  (create target first; add --no-default-features --features channel-store for Store)
  python tools/run_native_tests.py --cargo-messages <file> -- <test arguments>

No application executable, installer, registry, or production linker is changed.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>
</assembly>
'''

def select_test(messages: Path) -> Path:
    candidates: set[Path] = set()
    finished = False
    for line in messages.read_text(encoding="utf-8-sig").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue  # Cargo progress or wrapper diagnostics are not authority.
        if event.get("reason") == "build-finished":
            finished = event.get("success") is True
        target = event.get("target", {})
        if (event.get("reason") == "compiler-artifact"
            and event.get("profile", {}).get("test") is True
            and target.get("name") == "dmelopers_block_pet_lib"
            and Path(target.get("src_path", "")).resolve() == ROOT / "src-tauri/src/lib.rs"
            and event.get("executable")):
            candidate = Path(event["executable"]).resolve(strict=True)
            if not candidate.is_relative_to((ROOT / "target").resolve()):
                raise ValueError("test executable must remain under this workspace target directory")
            if candidate.parent.name != "deps" or not re.fullmatch(r"dmelopers_block_pet_lib-[0-9a-f]+\.exe", candidate.name):
                raise ValueError("only the exact Cargo native unit-test harness can run")
            candidates.add(candidate)
    if not finished or len(candidates) != 1:
        raise ValueError("require one native library test executable and successful Cargo build-finished")
    executable = candidates.pop()
    with executable.open("rb") as file:
        header = file.read(64)
        if header[:2] != b"MZ":
            raise ValueError("test executable is not a PE image")
        file.seek(struct.unpack_from("<I", header, 0x3C)[0])
        pe = file.read(96)
    if pe[:4] != b"PE\0\0" or struct.unpack_from("<H", pe, 4)[0] != 0x8664:
        raise ValueError("test executable must be Windows x64")
    return executable

def manifest_tool() -> Path:
    kits = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Windows Kits/10/bin"
    tools = sorted(kits.glob("*/x64/mt.exe"), key=lambda p: tuple(int(x) for x in p.parents[1].name.split(".")), reverse=True)
    if not tools:
        raise ValueError("Windows SDK mt.exe is required for the test harness manifest")
    return tools[0]

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cargo-messages", required=True, type=Path)
    parser.add_argument("test_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    executable = select_test(args.cargo_messages)
    manifest = executable.with_suffix(".test.manifest")
    manifest.write_text(MANIFEST, encoding="utf-8")
    subprocess.run([str(manifest_tool()), "-nologo", "-manifest", str(manifest), f"-outputresource:{executable};#1"], check=True)
    test_args = args.test_args[1:] if args.test_args[:1] == ["--"] else args.test_args
    return subprocess.run([str(executable), *test_args], cwd=ROOT, check=False).returncode

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Native test harness refused: {error}", file=sys.stderr)
        raise SystemExit(1)
