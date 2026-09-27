"""Pure contract tests; no installation, signing, network, or app execution."""
import importlib.util
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

spec = importlib.util.spec_from_file_location('packaging_builder', Path(__file__).with_name('package.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def native_fixture():
    data = bytearray(256)
    data[:2] = b'MZ'
    data[60:64] = (64).to_bytes(4, 'little')
    data[64:70] = b'PE\0\0\x64\x86'
    data[84:86] = (160).to_bytes(2, 'little')
    data[88:90] = b'\x0b\x02'
    data[196:200] = (16).to_bytes(4, 'little')
    return bytes(data) + b'__TAURI_BUNDLE_TYPE_VAR_UNK'


class PackageContracts(unittest.TestCase):
    def test_dual_build_finalizes_receipt_with_original_source_identity(self):
        """Run orchestration through finalization, replacing only external tools."""
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as patches:
            base = Path(temporary)
            source_root, output = base / 'source', base / 'output'
            for name in ('package.json', 'Cargo.lock', 'pnpm-lock.yaml', 'src-tauri/tauri.conf.json',
                         'src-tauri/tauri.github.conf.json', 'src-tauri/tauri.store.conf.json',
                         'src-tauri/update-trust.json', 'src-tauri/windows/github-installer.nsi',
                         'scripts/packaging/package.py', 'node_modules/@tauri-apps/cli/tauri.js'):
                file = source_root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('{}')
            (source_root / 'package.json').write_text('{"version":"1.0.1"}')
            (source_root / 'src-tauri/tauri.conf.json').write_text('{"bundle":{"resources":[]}}')
            sdk = base / 'makeappx.exe'
            sdk.write_bytes(b'fixture-tool')
            commit, tree = 'a'*40, 'b'*40
            def git(*args):
                if args == ('rev-parse', 'HEAD'): return commit
                if args == ('rev-parse', 'HEAD^{tree}'): return tree
                if args[0] == 'status': return ''
                raise AssertionError(args)
            def run(command, env, log):
                log.write_text('fixture tool output', encoding='utf-8')
                target = Path(env['CARGO_TARGET_DIR']) / builder.TARGET / 'release'
                if command[2] == 'build':
                    target.mkdir(parents=True)
                    (target / builder.MAIN).write_bytes(native_fixture())
                elif command[2] == 'bundle':
                    bundle = target / 'bundle/nsis'
                    bundle.mkdir(parents=True)
                    (bundle / 'fixture_1.0.1_x64-setup.exe').write_bytes(b'fixture-installer')
                elif command[2] == 'icon':
                    icons = Path(command[-1])
                    icons.mkdir()
                    for name in ('StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png'):
                        (icons / name).write_bytes(b'fixture-icon')
                elif command[1] == 'pack':
                    stage, package = Path(command[3]), Path(command[5])
                    with zipfile.ZipFile(package, 'w') as archive:
                        for file in stage.rglob('*'):
                            if file.is_file(): archive.write(file, file.relative_to(stage).as_posix())
                else:
                    raise AssertionError(command)
            def prepare(directory, target):
                builder.write(directory / 'installer-toolchain.json', {'fixture': True})
                return {}
            for name, replacement in {'ROOT': source_root, 'git': git, 'makeappx_tool': lambda: sdk,
                    'native_tool_inputs': lambda: {}, 'executable_tool_inputs': lambda *args: {}, 'run': run}.items():
                patches.enter_context(patch.object(builder, name, replacement))
            patches.enter_context(patch.object(builder.shutil, 'which', return_value='node.exe'))
            patches.enter_context(patch.object(builder.subprocess, 'check_output', return_value=builder.NSIS_CLI_VERSION))
            patches.enter_context(patch.object(builder.sys, 'path', list(builder.sys.path)))
            patches.enter_context(patch.dict(builder.sys.modules, {'prepare_installer_toolchain':
                SimpleNamespace(prepare=prepare, verify_unchanged=lambda *args: None)}))
            args = SimpleNamespace(identity=None, validation=True, reviewed_public_commit=commit,
                                   projection_manifest=None, output=output, tool_lock=None)
            result = builder.build(args)
            retained = json.loads((output / 'build-receipt.json').read_text(encoding='utf-8'))
            self.assertEqual(result, retained)
            self.assertEqual(retained['publicCommit'], commit)
            self.assertEqual(retained['publicTree'], tree)
            self.assertEqual(retained['purpose'], 'validation-only')
            self.assertEqual(set(retained['outputs']), {'github', 'storeSubmittedPackage'})
            self.assertNotEqual(retained['payloads']['githubCompiled']['sha256'],
                                retained['payloads']['github']['sha256'])

    def test_nsis_transform_is_exact_and_rejects_ambiguous_or_signed_inputs(self):
        raw = native_fixture()
        patched = builder.expected_nsis_image(raw, 'tauri-cli 2.11.4')
        self.assertEqual(patched, raw[:-3] + b'NSS')
        self.assertEqual(sum(a != b for a,b in zip(raw, patched)), 3)
        for bad in (raw[:-25], raw + b'__TAURI_BUNDLE_TYPE_VAR_UNK', patched,
                    raw + b'__TAURI_BUNDLE_TYPE_VAR_MSI'):
            with self.subTest(kind='marker'), self.assertRaisesRegex(ValueError, 'marker'):
                builder.expected_nsis_image(bad, 'tauri-cli 2.11.4')
        with self.assertRaisesRegex(ValueError, 'version'):
            builder.expected_nsis_image(raw, 'tauri-cli 2.11.5')
        with self.assertRaisesRegex(ValueError, 'Authenticode'):
            builder.expected_nsis_image(raw, 'tauri-cli 2.11.4', 'present')
        signed = bytearray(raw)
        signed[232:236] = (256).to_bytes(4, 'little')
        with self.assertRaisesRegex(ValueError, 'certificate'):
            builder.expected_nsis_image(bytes(signed), 'tauri-cli 2.11.4')

    def test_private_paths_are_rejected_in_utf8_and_utf16_payloads(self):
        private = r'C:\private-fixture\개발자 😶\source'
        builder.screen_private_paths(b'MZ public /block-pet/app/src/lib.rs', [private])
        for spelling in (private, private.replace('\\', '/').upper()):
            for encoding in ('utf-8', 'utf-16-le'):
                with self.subTest(encoding=encoding), self.assertRaises(ValueError):
                    builder.screen_private_paths(b'MZ' + spelling.encode(encoding), [private])

    def test_versions_are_shared_stable_with_zero_store_revision(self):
        self.assertEqual(builder.version('1.0.1'), '1.0.1.0')
        for bad in ('0.9.9', '1.0.0.1', '1.0.1-beta', '01.0.0', '1.65536.0', '1.0.-1'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                builder.version(bad)

    def test_real_identity_fails_closed_and_validation_cannot_override(self):
        with self.assertRaises(ValueError):
            builder.identity(None, False)
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'identity.json'
            file.write_text(json.dumps(builder.SYNTHETIC))
            with self.assertRaises(ValueError):
                builder.identity(file, False)
            with self.assertRaises(ValueError):
                builder.identity(file, True)
        self.assertEqual(builder.identity(None, True), builder.SYNTHETIC)
        with self.assertRaisesRegex(ValueError, 'Synthetic'):
            builder.validate_identity({'name': 'DMeloper.BlockPet', 'publisher': 'CN=registered',
                'publisherDisplayName': 'DMeloper', 'storeProductId': '9SYNTHETIC00'})

    def test_manifest_has_full_trust_startup_defer_and_supported_windows(self):
        root = ET.fromstring(builder.manifest(builder.SYNTHETIC, '1.0.1'))
        ns = {k or 'f': v for k, v in builder.NS.items()}
        self.assertEqual(root.find('f:Identity', ns).get('Version'), '1.0.1.0')
        self.assertEqual(root.find('f:Properties/uap17:UpdateWhileInUse', ns).text, 'defer')
        self.assertEqual(root.find('f:Dependencies/f:TargetDeviceFamily', ns).get('MinVersion'), '10.0.26100.0')
        app = root.find('f:Applications/f:Application', ns)
        self.assertEqual(app.get('{'+ns['uap10']+'}RuntimeBehavior'), 'packagedClassicApp')
        self.assertEqual(app.get('{'+ns['uap10']+'}TrustLevel'), 'mediumIL')
        self.assertEqual(root.find('.//desktop:StartupTask', ns).get('Enabled'), 'false')
        self.assertEqual(root.find('f:Capabilities/rescap:Capability', ns).get('Name'), 'runFullTrust')

    def test_msix_rejects_wrong_identity_and_installer_payload(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'fixture.msix'
            with zipfile.ZipFile(file, 'w') as archive:
                archive.writestr('AppxManifest.xml', builder.manifest(builder.SYNTHETIC, '1.0.1'))
                archive.writestr(builder.MAIN, b'MZfixture')
            self.assertEqual(len(builder.verify_msix(file, '1.0.1', builder.SYNTHETIC)), 2)
            with self.assertRaises(ValueError):
                builder.verify_msix(file, '1.0.2', builder.SYNTHETIC)
            with zipfile.ZipFile(file, 'a') as archive:
                archive.writestr('uninstall.exe', b'MZfixture')
            with self.assertRaises(ValueError):
                builder.verify_msix(file, '1.0.1', builder.SYNTHETIC)


if __name__ == '__main__':
    unittest.main()
