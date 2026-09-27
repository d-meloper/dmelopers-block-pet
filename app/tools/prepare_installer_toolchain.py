#!/usr/bin/env python3
"""Materialize verified NSIS 3.12 in a fresh candidate-local Tauri tool directory."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import urllib.request
import zipfile

NSIS_URL = 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.12/nsis-3.12.zip'
NSIS_SHA256 = '56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f'
UTILS_URL = 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll'
UTILS_SHA256 = '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709'


def checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verified_input(output: Path, url: str, expected: str, variable: str) -> Path:
    configured = os.environ.get(variable)
    if configured:
        source = Path(configured)
        if source.is_symlink() or not source.is_file() or checksum(source) != expected:
            raise ValueError(f'{variable} does not match the pinned official input')
        shutil.copyfile(source, output)
    else:
        with urllib.request.urlopen(url, timeout=60) as response, output.open('xb') as stream:
            total = 0
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > 16 * 1024 * 1024:
                    raise ValueError('installer tool download exceeds the reviewed size limit')
                stream.write(block)
    if checksum(output) != expected:
        raise ValueError('installer tool input digest mismatch')
    return output


def inventory(root: Path) -> list[dict]:
    return [{'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size,
             'sha256': checksum(path)} for path in sorted(root.rglob('*')) if path.is_file()]


def prepare(candidate_root: Path, cargo_target: Path) -> dict:
    # A new bundle-only target avoids replacing a user's or Tauri's cached tools.
    root = cargo_target / '.tauri/NSIS'
    if os.path.lexists(root):
        raise ValueError('NSIS tool destination must be fresh')
    inputs = candidate_root / 'installer-tool-inputs'
    inputs.mkdir()
    archive = verified_input(inputs / 'nsis-3.12.zip', NSIS_URL, NSIS_SHA256,
                             'RELEASE_NSIS_ARCHIVE_PATH')
    original_utils = verified_input(inputs / 'nsis_tauri_utils-0.5.3.dll', UTILS_URL, UTILS_SHA256,
                                    'RELEASE_NSIS_ORIGINAL_UTILS_PATH')
    root.mkdir(parents=True)
    seen = set()
    with zipfile.ZipFile(archive) as zipped:
        for item in zipped.infolist():
            parts = PurePosixPath(item.filename).parts
            if not parts or parts[0] != 'nsis-3.12' or any(part in {'.', '..'} or ':' in part or '\\' in part for part in parts):
                raise ValueError('unexpected pinned NSIS archive member')
            if item.is_dir():
                continue
            if len(parts) < 2 or item.file_size > 16 * 1024 * 1024 or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('unsupported NSIS archive member')
            relative = '/'.join(parts[1:])
            if relative.casefold() in seen:
                raise ValueError('duplicate NSIS archive member')
            seen.add(relative.casefold())
            destination = root.joinpath(*parts[1:])
            destination.parent.mkdir(parents=True, exist_ok=True)
            with zipped.open(item) as source, destination.open('xb') as target:
                shutil.copyfileobj(source, target)
    extra = root / 'Plugins/x86-unicode/additional/nsis_tauri_utils.dll'
    extra.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(original_utils, extra)
    version = subprocess.check_output([str(root / 'makensis.exe'), '/VERSION'], text=True).strip()
    if version != 'v3.12':
        raise ValueError('NSIS compiler is not the pinned 3.12 release')
    evidence = {'version': version, 'archive': {'url': NSIS_URL, 'sha256': NSIS_SHA256},
                'tauriCompatibilityPlugin': {'url': UTILS_URL, 'sha256': UTILS_SHA256,
                    'purpose': 'Tauri tool validation only; payload membership is proved by final extraction'},
                'files': inventory(root)}
    (candidate_root / 'installer-toolchain.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    return evidence


def verify_unchanged(cargo_target: Path, evidence: dict) -> None:
    if inventory(cargo_target / '.tauri/NSIS') != evidence['files']:
        raise ValueError('NSIS toolchain changed during bundling')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', required=True, type=Path)
    parser.add_argument('--target-dir', required=True, type=Path)
    arguments = parser.parse_args()
    arguments.evidence_dir.mkdir(parents=True, exist_ok=False)
    result = prepare(arguments.evidence_dir, arguments.target_dir)
    print(json.dumps({'version': result['version'], 'files': len(result['files'])}))
