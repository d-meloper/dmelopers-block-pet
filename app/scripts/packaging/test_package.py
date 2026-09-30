"""Pure contract tests; no installation, signing, network, or app execution."""
import importlib.util
from contextlib import ExitStack, redirect_stdout
import io
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
    def test_source_state_preserves_clean_and_head_requirements(self):
        commit = 'a'*40
        with patch.object(builder, 'git', side_effect=[commit, '']) as git:
            builder.assert_source_state(commit, 'after github native build')
        self.assertEqual(git.call_args_list[-1].args,
            ('-c', 'status.relativePaths=false', 'status', '--porcelain=v1', '--untracked-files=all', '-z'))
        self.assertEqual(git.call_args_list[-1].kwargs, {'strip': False})
        for head, status, detail in (('b'*40, '', 'HEAD=' + 'b'*40),
                (commit, ' M app/vendor/permissions.json\0', ' M app/vendor/permissions.json'),
                (commit, '?? app/untracked.txt\0', '?? app/untracked.txt')):
            with self.subTest(head=head, status=status), patch.object(builder, 'git', side_effect=[head, status]), \
                 self.assertRaises(ValueError) as error:
                builder.assert_source_state(commit, 'after github native build')
            self.assertIn('after github native build', str(error.exception))
            self.assertIn(detail, str(error.exception))
            self.assertIn('expected=' + commit, str(error.exception))

    def test_source_diagnostics_bound_paths_and_parse_rename_framing(self):
        commit = 'a'*40
        status = 'R  app/new name.py\0app/old name.py\0 M /private/absolute.txt\0'
        status += ''.join('?? app/' + str(i) + 'x'*400 + '\0' for i in range(20))
        with patch.object(builder, 'git', side_effect=[commit, status]), self.assertRaises(ValueError) as error:
            builder.assert_source_state(commit, 'after GitHub NSIS bundle')
        message = str(error.exception)
        self.assertIn('R  app/new name.py', message)
        self.assertNotIn('old name.py', message)
        self.assertNotIn('/private/absolute.txt', message)
        self.assertIn('additionalPaths=10', message)
        self.assertLess(len(message), 3000)

    def test_run_progress_contains_only_log_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'build-github.log'
            for code, outcome in ((0, 'completed'), (1, 'failed')):
                output = io.StringIO()
                with patch.object(builder.subprocess, 'run', return_value=SimpleNamespace(returncode=code)), \
                     redirect_stdout(output):
                    if code:
                        with self.assertRaises(ValueError):
                            builder.run(['private-command'], {'SECRET': 'not-logged'}, log)
                    else:
                        builder.run(['private-command'], {'SECRET': 'not-logged'}, log)
                self.assertEqual(output.getvalue(), f'Packaging started: {log.name}\nPackaging {outcome}: {log.name}\n')

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
            run_logs, dirty_stage = [], None
            def git(*args, **kwargs):
                if args == ('rev-parse', 'HEAD'): return commit
                if args == ('rev-parse', 'HEAD^{tree}'): return tree
                if 'status' in args:
                    return ' M app/generated.json\0' if dirty_stage and run_logs and run_logs[-1] == dirty_stage else ''
                raise AssertionError(args)
            def run(command, env, log):
                run_logs.append(log.name)
                log.write_text('fixture tool output', encoding='utf-8')
                target = Path(env['CARGO_TARGET_DIR']) / builder.TARGET / 'release'
                if command[2] == 'build':
                    target.mkdir(parents=True, exist_ok=True)
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
            checks = patches.enter_context(patch.object(builder, 'assert_source_state', wraps=builder.assert_source_state))
            args = SimpleNamespace(identity=None, validation=True, reviewed_public_commit=commit,
                                   projection_manifest=None, output=output, tool_lock=None)
            result = builder.build(args)
            self.assertEqual([call.args[1] for call in checks.call_args_list],
                ['before packaging', 'after github native build', 'after GitHub NSIS bundle',
                 'after store native build', 'after both packages'])
            retained = json.loads((output / 'build-receipt.json').read_text(encoding='utf-8'))
            self.assertEqual(result, retained)
            self.assertEqual(retained['publicCommit'], commit)
            self.assertEqual(retained['publicTree'], tree)
            self.assertEqual(retained['purpose'], 'validation-only')
            self.assertEqual(set(retained['outputs']), {'github', 'storeSubmittedPackage'})
            self.assertNotEqual(retained['payloads']['githubCompiled']['sha256'],
                                retained['payloads']['github']['sha256'])
            # Warm compiler targets are reused, but every retained candidate is independent.
            args.cache_root = base / 'cache'
            snapshots = []
            for iteration in range(2):
                args.output = base / ('cached-output-' + str(iteration))
                cached = builder.build(args)
                snapshots.append((args.output, cached))
            targets = list(args.cache_root.glob('github-*')) + list(args.cache_root.glob('store-*'))
            self.assertEqual(len(targets), 2)
            for target in targets:
                (target / builder.TARGET / 'release' / builder.MAIN).write_bytes(b'changed cache')
            for directory, cached in snapshots:
                for channel in ('github', 'store'):
                    retained_binary = directory / ('target-' + channel) / builder.TARGET / 'release' / builder.MAIN
                    self.assertEqual(retained_binary.read_bytes(), native_fixture())
                self.assertEqual(cached['outputs']['github']['sha256'], builder.digest(directory / cached['outputs']['github']['name']))
            # A dirty GitHub build must stop before bundling or compiling Store.
            run_logs.clear()
            dirty_stage = 'build-github.log'
            args.output = base / 'blocked-output'
            with self.assertRaisesRegex(ValueError, 'after github native build'):
                builder.build(args)
            self.assertEqual(run_logs, ['build-github.log'])

    def test_compiler_cache_is_exclusive_separate_and_released_after_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            cache, output = base / 'cache', base / 'candidate'
            with builder.compiler_cache(cache, output):
                with self.assertRaisesRegex(ValueError, 'already in use'):
                    with builder.compiler_cache(cache, base / 'other'): pass
            with self.assertRaisesRegex(RuntimeError, 'build failed'):
                with builder.compiler_cache(cache, output): raise RuntimeError('build failed')
            with builder.compiler_cache(cache, output): pass
            for bad_cache, bad_output in ((cache, cache / 'candidate'), (output / 'cache', output)):
                with self.assertRaisesRegex(ValueError, 'separate'):
                    with builder.compiler_cache(bad_cache, bad_output): pass
            with self.assertRaisesRegex(ValueError, 'absolute'):
                with builder.compiler_cache(Path('relative-cache'), output): pass
            with patch.object(builder, 'ROOT', base / 'source'):
                with self.assertRaisesRegex(ValueError, 'source'):
                    with builder.compiler_cache(base / 'source/cache', output): pass

    def test_cache_namespace_separates_channel_tools_flags_and_store_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            values = [('github', {'rustc': 'one'}, ['flag'], builder.SYNTHETIC),
                      ('store', {'rustc': 'one'}, ['flag'], builder.SYNTHETIC),
                      ('github', {'rustc': 'two'}, ['flag'], builder.SYNTHETIC),
                      ('github', {'rustc': 'one'}, ['other'], builder.SYNTHETIC),
                      ('store', {'rustc': 'one'}, ['flag'], {**builder.SYNTHETIC, 'name': 'Real.Product'})]
            self.assertEqual(len({builder.cache_target(root, *value) for value in values}), len(values))
            self.assertEqual(builder.cache_target(root, *values[0]), builder.cache_target(root, *values[0]))

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
