"""Pure contract tests; no installation, signing, network, or app execution."""
import importlib.util
from contextlib import ExitStack, redirect_stdout
import io
import json
import os
import shutil
import struct
import zlib
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

    def test_store_display_names_match_reservation_without_changing_package_identity(self):
        root = ET.fromstring(builder.manifest(builder.SYNTHETIC, '1.0.1'))
        ns = {k or 'f': v for k, v in builder.NS.items()}
        expected = "DMeloper's Block Pet"
        self.assertEqual(root.find('f:Properties/f:DisplayName', ns).text, expected)
        self.assertEqual(root.find('.//uap:VisualElements', ns).get('DisplayName'), expected)
        startup = root.find('.//desktop:StartupTask', ns)
        self.assertEqual(startup.get('DisplayName'), expected)
        self.assertEqual(startup.get('TaskId'), 'BlockPetStartup')
        self.assertEqual(root.find('f:Identity', ns).attrib, {
            'Name': builder.SYNTHETIC['name'], 'Publisher': builder.SYNTHETIC['publisher'],
            'Version': '1.0.1.0', 'ProcessorArchitecture': 'x64'})

    def test_new_msix_rejects_unreserved_package_visual_and_startup_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'fixture.msix'
            original = ET.fromstring(builder.manifest(builder.SYNTHETIC, '1.0.1'))
            ns = {k or 'f': v for k, v in builder.NS.items()}
            for element, attribute in (('f:Properties/f:DisplayName', None),
                                       ('.//uap:VisualElements', 'DisplayName'),
                                       ('.//desktop:StartupTask', 'DisplayName')):
                with self.subTest(element=element):
                    changed = ET.fromstring(ET.tostring(original))
                    node = changed.find(element, ns)
                    if attribute:
                        node.set(attribute, "DMeloper's Block Pet (Store)")
                    else:
                        node.text = "DMeloper's Block Pet (Store)"
                    with zipfile.ZipFile(file, 'w') as archive:
                        archive.writestr('AppxManifest.xml', ET.tostring(changed))
                        archive.writestr(builder.MAIN, b'MZfixture')
                    with self.assertRaisesRegex(ValueError, 'reserved Store'):
                        builder.verify_msix(file, '1.0.1', builder.SYNTHETIC,
                                            expected_minimum_windows=builder.MINIMUM_WINDOWS_VERSION)
                    # Retained evidence is still inspectable under its original contract.
                    self.assertEqual(len(builder.verify_msix(file, '1.0.1', builder.SYNTHETIC)), 2)

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



def png_fixture(size, alpha=0):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
    raw = (b'\0' + bytes([20, 40, 60, alpha]) * size) * size
    # One visible pixel; the exterior keeps the requested alpha.
    raw = raw[:4] + b'\xff' + raw[5:]
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


class StoreResourceContracts(unittest.TestCase):
    def test_complete_target_matrix_and_pixel_validation(self):
        self.assertEqual(builder.STORE_TARGET_SIZES, (16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256))
        self.assertEqual(len(builder.store_asset_sizes()), 45)
        for name, size in builder.store_asset_sizes().items():
            with self.subTest(name=name):
                builder.verify_store_png(png_fixture(size), size)
        for data in (b'bad', png_fixture(20), png_fixture(16, 255), png_fixture(16)[:-1]):
            with self.subTest(data=data[:16]), self.assertRaises(ValueError):
                builder.verify_store_png(data, 16)
        corrupt = bytearray(png_fixture(16)); corrupt[-16] ^= 1
        with self.assertRaisesRegex(ValueError, 'checksum'):
            builder.verify_store_png(corrupt, 16)

    def test_makepri_must_exist_in_the_selected_sdk(self):
        with tempfile.TemporaryDirectory() as temporary:
            sdk = Path(temporary) / '10.0.26100.0/x64'
            sdk.mkdir(parents=True)
            appx = sdk / 'makeappx.exe'
            appx.write_bytes(b'appx')
            with self.assertRaisesRegex(ValueError, 'Selected Windows SDK'):
                builder.makepri_tool(appx)
            (sdk / 'makepri.exe').write_bytes(b'pri')
            self.assertEqual(builder.makepri_tool(appx), (sdk / 'makepri.exe').resolve())


class StoreResourceSdkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.makepri = builder.makepri_tool(builder.makeappx_tool())
        except (OSError, ValueError) as error:
            raise unittest.SkipTest(str(error))
        cls.temporary = tempfile.TemporaryDirectory(prefix='block-pet-store-resource-test-')
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.output = Path(cls.temporary.name)
        cls.stage = cls.output / 'msix-stage'
        cls.stage.mkdir()
        (cls.stage / 'AppxManifest.xml').write_bytes(builder.manifest(builder.SYNTHETIC, '1.1.4'))
        cls.evidence = builder.generate_store_resources(cls.stage, cls.output, builder.SYNTHETIC,
                shutil.which('node.exe'), builder.ROOT / 'node_modules/@tauri-apps/cli/tauri.js', cls.makepri, os.environ.copy())

    def test_actual_generation_pri_and_packaged_readback(self):
        self.assertEqual(len(self.evidence['assets']), 45)
        artifact = self.output / 'synthetic-resources.zip'
        with zipfile.ZipFile(artifact, 'w') as archive:
            for file in self.stage.rglob('*'):
                if file.is_file(): archive.write(file, file.relative_to(self.stage).as_posix())
        actual = builder.verify_msix_store_resources(artifact, builder.SYNTHETIC, self.makepri,
                 os.environ.copy(), self.output / 'archive-dump.log', self.output / 'archive-dump.xml')
        self.assertEqual(actual['pri'], self.evidence['pri'])
        self.assertEqual(actual['assets'], self.evidence['assets'])
        with self.assertRaisesRegex(ValueError, 'identity'):
            builder.verify_store_pri_dump((self.output / 'archive-dump.xml').read_bytes(), {'name': 'Wrong.Identity'})

    def test_missing_assets_wrong_dimensions_and_missing_pri_fail_before_dump(self):
        for index, defect in enumerate(('missing', 'dimensions', 'opaque', 'pri')):
            stage = self.output / ('negative-' + defect)
            shutil.copytree(self.stage, stage)
            asset = stage / 'StoreAssets/Square44x44Logo.targetsize-16_altform-unplated.png'
            if defect == 'missing': asset.unlink()
            elif defect == 'dimensions': asset.write_bytes(png_fixture(20))
            elif defect == 'opaque': asset.write_bytes(png_fixture(16, 255))
            else: (stage / 'resources.pri').unlink()
            with self.subTest(defect=defect), patch.object(builder, 'run') as run, self.assertRaises(ValueError):
                builder.verify_store_resources(stage, builder.SYNTHETIC, self.makepri, os.environ.copy(),
                         self.output / f'negative-{index}.log', self.output / f'negative-{index}.xml')
            run.assert_not_called()

    def test_pri_must_register_every_size_form_under_the_manifest_logo(self):
        original = (self.output / 'resources.pri.xml').read_bytes()
        root = ET.fromstring(original)
        logo = root.find('.//NamedResource[@name="Square44x44Logo.png"]')
        for candidate in list(logo.findall('Candidate')):
            qualifiers = {q.get('name'): q.get('value') for q in candidate.findall('QualifierSet/Qualifier')}
            if qualifiers.get('AlternateForm') == 'LIGHTUNPLATED':
                logo.remove(candidate)
                break
        with self.assertRaisesRegex(ValueError, 'candidate'):
            builder.verify_store_pri_dump(ET.tostring(root), builder.SYNTHETIC)
        root = ET.fromstring(original)
        candidate = root.find('.//Candidate')
        candidate.find('Value').text = 'StoreAssets/wrong.png'
        with self.assertRaisesRegex(ValueError, 'candidate'):
            builder.verify_store_pri_dump(ET.tostring(root), builder.SYNTHETIC)
        root = ET.fromstring(original)
        candidate = root.find('.//Candidate')
        root.find('.//Candidate/QualifierSet/Qualifier').set('value', '44')
        with self.assertRaisesRegex(ValueError, 'candidate'):
            builder.verify_store_pri_dump(ET.tostring(root), builder.SYNTHETIC)
        broken = self.output / 'broken-pri'
        shutil.copytree(self.stage, broken)
        (broken / 'resources.pri').write_bytes(b'not a PRI')
        with self.assertRaisesRegex(ValueError, 'Build command failed'):
            builder.verify_store_resources(broken, builder.SYNTHETIC, self.makepri, os.environ.copy(),
                  self.output / 'broken-pri.log', self.output / 'broken-pri.xml')


if __name__ == '__main__':
    unittest.main()
