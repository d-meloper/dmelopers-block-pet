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
    def test_store_config_removes_development_inputs_and_keeps_embedded_frontend(self):
        base = json.loads((builder.ROOT / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
        store = json.loads((builder.ROOT / 'src-tauri/tauri.store.conf.json').read_text(encoding='utf-8'))
        self.assertTrue(base['build']['devUrl'])
        self.assertTrue(base['build']['beforeDevCommand'])
        self.assertEqual(set(store['build']), {'devUrl', 'beforeDevCommand'})
        for key in ('devUrl', 'beforeDevCommand'):
            self.assertIsNone(store['build'][key])
        # The release still builds and embeds its frontend using the base config.
        self.assertEqual(base['build']['beforeBuildCommand'], 'pnpm build')
        self.assertEqual(base['build']['frontendDist'], '../dist')
        self.assertFalse(store['bundle']['active'])
        self.assertEqual(store['bundle']['windows']['webviewInstallMode']['type'], 'skip')

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
            builder.assert_source_state(commit, 'after Store package')
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
        family = root.find('f:Dependencies/f:TargetDeviceFamily', ns)
        self.assertEqual(family.get('MinVersion'), '10.0.19045.3448')
        self.assertEqual(family.get('MaxVersionTested'), '10.0.26100.0')
        self.assertIn('uap17', root.get('IgnorableNamespaces').split())
        app = root.find('f:Applications/f:Application', ns)
        self.assertEqual(app.get('{'+ns['uap10']+'}RuntimeBehavior'), 'packagedClassicApp')
        self.assertEqual(app.get('{'+ns['uap10']+'}TrustLevel'), 'mediumIL')
        self.assertEqual(root.find('.//desktop:StartupTask', ns).get('Enabled'), 'false')
        self.assertEqual(root.find('f:Capabilities/rescap:Capability', ns).get('Name'), 'runFullTrust')

    def test_store_display_names_are_distinct_without_changing_package_identity(self):
        root = ET.fromstring(builder.manifest(builder.SYNTHETIC, '1.0.1'))
        ns = {k or 'f': v for k, v in builder.NS.items()}
        expected = "DMeloper's Block Pet (Store)"
        self.assertEqual(root.find('f:Properties/f:DisplayName', ns).text, expected)
        self.assertEqual(root.find('.//uap:VisualElements', ns).get('DisplayName'), expected)
        startup = root.find('.//desktop:StartupTask', ns)
        self.assertEqual(startup.get('DisplayName'), expected)
        self.assertEqual(startup.get('TaskId'), 'BlockPetStartup')
        self.assertEqual(root.find('f:Identity', ns).attrib, {
            'Name': builder.SYNTHETIC['name'], 'Publisher': builder.SYNTHETIC['publisher'],
            'Version': '1.0.1.0', 'ProcessorArchitecture': 'x64'})

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

    def test_new_package_verifies_requirements_without_rewriting_retained_candidates(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'fixture.msix'
            original = ET.fromstring(builder.manifest(builder.SYNTHETIC, '1.0.1'))
            ns = {k or 'f': v for k, v in builder.NS.items()}

            def package(node):
                with zipfile.ZipFile(file, 'w') as archive:
                    archive.writestr('AppxManifest.xml', ET.tostring(node))
                    archive.writestr(builder.MAIN, b'MZfixture')

            package(original)
            self.assertEqual(len(builder.verify_msix(file, '1.0.1', builder.SYNTHETIC,
                    expected_minimum_windows='10.0.19045.3448')), 2)
            for element, attribute, value in (
                    ('f:Dependencies/f:TargetDeviceFamily', 'MinVersion', '10.0.19045.3447'),
                    ('f:Dependencies/f:TargetDeviceFamily', 'MinVersion', '10.0.26100.0'),
                    ('f:Dependencies/f:TargetDeviceFamily', 'MaxVersionTested', '10.0.19045.3448'),
                    ('.', 'IgnorableNamespaces', 'uap uap10 desktop rescap')):
                with self.subTest(attribute=attribute, value=value):
                    changed = ET.fromstring(ET.tostring(original))
                    changed.find(element, ns).set(attribute, value)
                    package(changed)
                    with self.assertRaises(ValueError):
                        builder.verify_msix(file, '1.0.1', builder.SYNTHETIC,
                                expected_minimum_windows='10.0.19045.3448')
            retained = ET.fromstring(ET.tostring(original))
            retained.find('f:Dependencies/f:TargetDeviceFamily', ns).set('MinVersion', '10.0.26100.0')
            package(retained)
            self.assertEqual(len(builder.verify_msix(file, '1.0.1', builder.SYNTHETIC)), 2)
            for keep_defer in (False, True):
                changed = ET.fromstring(ET.tostring(original))
                defer = changed.find('f:Properties/uap17:UpdateWhileInUse', ns)
                if keep_defer:
                    defer.text = 'close'
                else:
                    changed.find('f:Properties', ns).remove(defer)
                package(changed)
                with self.assertRaisesRegex(ValueError, 'optional'):
                    builder.verify_msix(file, '1.0.1', builder.SYNTHETIC,
                            expected_minimum_windows='10.0.19045.3448')


if __name__ == '__main__':
    unittest.main()
