"""Boundary tests for the explicit native unit-test runner; no programs are run."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("run_native_tests", Path(__file__).with_name("run_native_tests.py"))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

class TestNativeRunner(unittest.TestCase):
    def test_rejects_cargo_failure_and_production_application(self):
        with tempfile.TemporaryDirectory() as directory:
            messages = Path(directory) / "cargo.jsonl"
            messages.write_text(json.dumps({"reason": "build-finished", "success": False}), encoding="utf-8")
            with self.assertRaises(ValueError): runner.select_test(messages)
            messages.write_text(json.dumps({"reason": "compiler-artifact", "profile": {"test": False}, "target": {"name": "dmelopers-block-pet"}, "executable": "app.exe"}) + '\n' + json.dumps({"reason": "build-finished", "success": True}), encoding="utf-8")
            with self.assertRaises(ValueError): runner.select_test(messages)

    def test_accepts_only_exact_workspace_unit_harness_path(self):
        with tempfile.TemporaryDirectory(dir=runner.ROOT / "target") as directory:
            temp = Path(directory)
            (temp / "deps").mkdir()
            exe = temp / "deps/dmelopers_block_pet_lib-aabbcc0011.exe"
            pe = bytearray(192)
            pe[:2] = b"MZ"
            struct.pack_into('<I', pe, 0x3c, 64)
            pe[64:68] = b"PE\0\0"
            struct.pack_into('<H', pe, 68, 0x8664)
            exe.write_bytes(pe)
            artifact = {"reason": "compiler-artifact", "profile": {"test": True}, "target": {"name": "dmelopers_block_pet_lib", "src_path": str(runner.ROOT / "src-tauri/src/lib.rs")}, "executable": str(exe)}
            messages = temp / "cargo.jsonl"
            def write(): messages.write_text(json.dumps(artifact) + '\n' + json.dumps({"reason": "build-finished", "success": True}), encoding="utf-8")
            write()
            self.assertEqual(runner.select_test(messages), exe.resolve())
            production = temp / "dmelopers-block-pet.exe"
            production.write_bytes(pe)
            artifact["executable"] = str(production)
            write()
            with self.assertRaises(ValueError): runner.select_test(messages)

if __name__ == '__main__': unittest.main()
