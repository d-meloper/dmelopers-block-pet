#!/usr/bin/env python3
"""Standalone Windows package builder. Never publishes or modifies installed data.

Use build.ps1 to activate the Visual Studio x64 tools. Validation builds use a clearly
synthetic Store identity; only local builds from a reviewed, clean public commit
can carry release provenance. Receipts prove inputs, not reproducible CI bytes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
TARGET = 'x86_64-pc-windows-msvc'
MAIN = 'dmelopers-block-pet.exe'
NSIS_CLI_VERSION = 'tauri-cli 2.11.4'
NSIS_PAYLOAD_DIRECTORY = 'github-packaged'
SYNTHETIC = {'name': 'Dmeloper.BlockPet.BuildValidation',
             'publisher': 'CN=BuildValidationOnly', 'publisherDisplayName': 'DMeloper',
             'storeProductId': '9SYNTHETIC00'}
NS = {'': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10',
      'uap': 'http://schemas.microsoft.com/appx/manifest/uap/windows10',
      'uap10': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/10',
      'uap17': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/17',
      'desktop': 'http://schemas.microsoft.com/appx/manifest/desktop/windows10',
      'rescap': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def screen_private_paths(data, paths):
    """Check actual payload bytes as well as requesting compiler path remapping."""
    folded = data.lower()
    for path in paths:
        for spelling in (str(path).replace('\\', '/'), str(path).replace('/', '\\')):
            for encoding in ('utf-8', 'utf-16-le'):
                require(spelling.encode(encoding).lower() not in folded,
                        'A private build path remains in the native payload')


def record(path):
    path = Path(path)
    return {'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)}


def expected_nsis_image(data, cli_version, authenticode='absent'):
    """Pinned Tauri 2.11.4 bundle.rs patches the first token, then restores raw.

    This is an expected package image, not independent installer extraction or
    security evidence. Refuse ambiguous markers and signed inputs.
    """
    require(cli_version == NSIS_CLI_VERSION, 'Unreviewed Tauri NSIS transformation version')
    require(authenticode == 'absent', 'NSIS transformation requires absent Authenticode')
    require(len(data) >= 64 and data[:2] == b'MZ', 'Invalid native PE image')
    pe = int.from_bytes(data[60:64], 'little')
    optional = pe + 24
    require(pe >= 64 and optional + 152 <= len(data) and data[pe:pe+4] == b'PE\0\0'
            and data[pe+4:pe+6] == b'\x64\x86'
            and int.from_bytes(data[pe+20:pe+22], 'little') >= 152
            and data[optional:optional+2] == b'\x0b\x02'
            and int.from_bytes(data[optional+108:optional+112], 'little') >= 5,
            'Expected x64 PE32+ certificate directory')
    require(data[optional+144:optional+152] == b'\0'*8,
            'Authenticode certificate directory must be empty')
    unknown, nsis = b'__TAURI_BUNDLE_TYPE_VAR_UNK', b'__TAURI_BUNDLE_TYPE_VAR_NSS'
    require(data.count(unknown) == 1 and data.count(b'__TAURI_BUNDLE_TYPE_VAR_') == 1,
            'Expected exactly one unpatched Tauri bundle marker')
    return data.replace(unknown, nsis, 1)


def write(path, value):
    with Path(path).open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def version(value):
    require(isinstance(value, str) and re.fullmatch(r'[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', value),
            'Version must be stable X.Y.Z with major >= 1')
    require(all(int(part) <= 65535 for part in value.split('.')), 'Store version component exceeds 65535')
    return value + '.0'


def identity(path, validation):
    if validation:
        require(path is None, 'Validation uses only the documented synthetic identity')
        return SYNTHETIC.copy()
    require(path is not None, 'Registered Partner Center identity JSON is required for release builds')
    value = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    return validate_identity(value)


def validate_identity(value):
    require(isinstance(value, dict) and set(value) == set(SYNTHETIC), 'Store identity fields differ from the schema')
    require(all(isinstance(x, str) and x.strip() == x and x for x in value.values()),
            'Store identity must be fully registered; placeholders are not valid')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{2,49}', value['name']), 'Invalid Store identity Name')
    require(value['publisher'].startswith('CN='), 'Exact Partner Center Publisher is required')
    require(value['publisherDisplayName'] == 'DMeloper', 'Publisher display name must be DMeloper')
    require(re.fullmatch(r'[A-Z0-9]{12}', value['storeProductId']), 'Registered Store product ID is required')
    require(not any(re.search(r'(?i)placeholder|replace|validation|example|synthetic', x) for x in value.values()),
            'Synthetic identities cannot produce release candidates')
    return value


def manifest(store, app_version):
    for prefix, uri in NS.items():
        ET.register_namespace(prefix, uri)
    def tag(name):
        prefix, local = name.split(':') if ':' in name else ('', name)
        return '{' + NS[prefix] + '}' + local
    def add(parent, name, attrs=None, text=None):
        node = ET.SubElement(parent, tag(name), attrs or {})
        node.text = text
        return node
    package = ET.Element(tag('Package'), {'IgnorableNamespaces': 'uap uap10 uap17 desktop rescap'})
    add(package, 'Identity', {'Name': store['name'], 'Publisher': store['publisher'],
                             'Version': version(app_version), 'ProcessorArchitecture': 'x64'})
    properties = add(package, 'Properties')
    add(properties, 'DisplayName', text="DMeloper's Block Pet")
    add(properties, 'PublisherDisplayName', text='DMeloper')
    add(properties, 'Logo', text='StoreAssets\\StoreLogo.png')
    add(properties, 'uap17:UpdateWhileInUse', text='defer')
    dependencies = add(package, 'Dependencies')
    add(dependencies, 'TargetDeviceFamily', {'Name': 'Windows.Desktop', 'MinVersion': '10.0.26100.0',
                                           'MaxVersionTested': '10.0.26100.0'})
    resources = add(package, 'Resources')
    for language in ('en-US', 'ko-KR'):
        add(resources, 'Resource', {'Language': language})
    apps = add(package, 'Applications')
    app = add(apps, 'Application', {'Id': 'App', 'Executable': MAIN,
        tag('uap10:RuntimeBehavior'): 'packagedClassicApp', tag('uap10:TrustLevel'): 'mediumIL'})
    add(app, 'uap:VisualElements', {'DisplayName': "DMeloper's Block Pet", 'Description': 'Desktop pet',
        'BackgroundColor': 'transparent', 'Square150x150Logo': 'StoreAssets\\Square150x150Logo.png',
        'Square44x44Logo': 'StoreAssets\\Square44x44Logo.png'})
    extensions = add(app, 'Extensions')
    extension = add(extensions, 'desktop:Extension', {'Category': 'windows.startupTask',
        'Executable': MAIN, 'EntryPoint': 'Windows.FullTrustApplication'})
    add(extension, 'desktop:StartupTask', {'TaskId': 'BlockPetStartup', 'Enabled': 'false',
                                         'DisplayName': "DMeloper's Block Pet"})
    capabilities = add(package, 'Capabilities')
    add(capabilities, 'rescap:Capability', {'Name': 'runFullTrust'})
    return ET.tostring(package, encoding='utf-8', xml_declaration=True)


def git(*args, strip=True):
    output = subprocess.check_output(['git', '-C', str(ROOT), *args], text=True, encoding='utf-8')
    return output.strip() if strip else output


def assert_source_state(reviewed, stage):
    head = git('rev-parse', 'HEAD')
    status = git('-c', 'status.relativePaths=false', 'status', '--porcelain=v1',
                 '--untracked-files=all', '-z', strip=False)
    if head == reviewed and not status:
        return
    # NUL framing preserves spaces/Unicode and avoids Git's quoted-path parsing.
    # Report names only, bounded independently of the worktree's size.
    records = status.split('\0')
    paths, count, offset = [], 0, 0
    while offset < len(records):
        record = records[offset]
        offset += 1
        if not record:
            continue
        code, path = record[:2], record[3:]
        if 'R' in code or 'C' in code:
            offset += 1  # Rename/copy's second path; destination identifies drift.
        count += 1
        if len(paths) >= 12:
            continue
        if (len(record) < 4 or record[2] != ' ' or path.startswith(('/', '\\'))
                or re.match(r'[A-Za-z]:', path) or '..' in path.replace('\\', '/').split('/')):
            path = '[non-relative or malformed path]'
        paths.append(code + ' ' + path[:200])
    shown_head = head if re.fullmatch(r'[0-9a-f]{40}', head) else '[invalid HEAD]'
    raise ValueError(f'Source changed while packaging [{stage}]: HEAD={shown_head}; expected={reviewed}; '
                     f'paths={json.dumps(paths, ensure_ascii=True)}; additionalPaths={max(0, count - len(paths))}')


def source_identity(reviewed, validation):
    require(re.fullmatch(r'[0-9a-f]{40}', reviewed or ''), 'Exact reviewed public commit SHA is required')
    assert_source_state(reviewed, 'before packaging')
    if not validation:
        require(ROOT.name == 'app' and (ROOT.parent / '.github/public-files.json').is_file(),
                'Release producer must run from the reviewed standalone public projection app/')
        require(not os.environ.get('CI') and not os.environ.get('GITHUB_ACTIONS'),
                'Release candidates require the local producer, not CI')
    return {'publicCommit': reviewed, 'publicTree': git('rev-parse', 'HEAD^{tree}'),
            'clean': True, 'producer': 'ci-validation' if validation and os.environ.get('CI') else 'local',
            'purpose': 'validation-only' if validation else 'release-candidate'}


def projection_identity(path, validation):
    if validation:
        return None
    require(path is not None, 'Retained private-to-public export manifest is required')
    value = json.loads(path.read_text(encoding='utf-8'))
    require(value.get('kind') == '3d-pet-public-source-candidate', 'Invalid public projection manifest')
    require(re.fullmatch(r'[0-9a-f]{40}', value.get('source_commit', '')), 'Private source commit missing')
    expected = value.get('files')
    require(isinstance(expected, list) and expected, 'Public projection inventory missing')
    tree = hashlib.sha256()
    for item in sorted(expected, key=lambda x: x['path']):
        relative = item['path']
        require(not relative.startswith(('/', '\\')) and '\\' not in relative
                and '..' not in Path(relative).parts and ':' not in relative, 'Unsafe projection member')
        file = ROOT.parent / relative
        require(file.is_file() and not file.is_symlink() and digest(file) == item['sha256']
                and file.stat().st_size == item['bytes'], 'Reviewed projection bytes differ from source receipt')
        tree.update(relative.encode('utf-8') + b'\0' + bytes.fromhex(item['sha256']))
    require(tree.hexdigest() == value.get('public_tree_sha256'), 'Projection tree digest mismatch')
    tracked = set(subprocess.check_output(['git', '-C', str(ROOT.parent), 'ls-files', '-z'],
                                         text=True, encoding='utf-8').split('\0')) - {''}
    require(tracked == {item['path'] for item in expected}, 'Public projection file set differs from receipt')
    return {'manifestSha256': digest(path), 'privateSourceCommit': value['source_commit'],
            'privateSourceTree': value['source_tree'], 'publicTreeSha256': tree.hexdigest()}


def run(command, environment, log):
    # Executables/argument arrays only. Secrets and full environment are never recorded.
    print(f'Packaging started: {log.name}', flush=True)
    with log.open('ab') as stream:
        result = subprocess.run(command, cwd=ROOT, env=environment, stdout=stream, stderr=subprocess.STDOUT)
    print(f'Packaging {"completed" if result.returncode == 0 else "failed"}: {log.name}', flush=True)
    require(result.returncode == 0, 'Build command failed; retained build log contains diagnostics')


def makeappx_tool():
    configured = os.environ.get('BLOCK_PET_MAKEAPPX')
    if configured:
        path = Path(configured).resolve(strict=True)
    else:
        base = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Windows Kits/10/bin'
        matches = sorted(base.glob('10.0.*/x64/makeappx.exe'), key=lambda p: tuple(map(int, p.parent.parent.name.split('.'))))
        require(matches, 'Windows SDK MakeAppx x64 is required')
        path = matches[-1].resolve()
    require(path.is_file() and path.name.lower() == 'makeappx.exe', 'Invalid MakeAppx tool')
    require(tuple(map(int, path.parent.parent.name.split('.'))) >= (10, 0, 26100, 0),
            'Windows SDK 10.0.26100.0 or newer is required')
    return path


def native_tool_inputs():
    """Bind the developer-shell compiler and selected CRT/SDK, without local paths."""
    vc = Path(os.environ.get('VCToolsInstallDir', ''))
    sdk = Path(os.environ.get('WindowsSdkDir', ''))
    sdk_version = os.environ.get('WindowsSDKVersion', '').rstrip('\\/')
    require(vc.is_absolute() and sdk.is_absolute() and sdk_version, 'Run in an x64 Visual Studio developer shell')
    roots = {'msvc': vc / 'lib/x64', 'sdk-um': sdk / 'Lib' / sdk_version / 'um/x64',
             'sdk-ucrt': sdk / 'Lib' / sdk_version / 'ucrt/x64'}
    result = {}
    for label, directory in roots.items():
        require(directory.is_dir(), 'Selected native tool libraries are missing')
        files = sorted(directory.glob('*.lib'))
        require(files, 'Native library inventory is empty')
        result[label] = [record(file) for file in files]
    for name in ('cl.exe', 'link.exe'):
        file = vc / 'bin/Hostx64/x64' / name
        require(file.is_file(), 'Selected x64 compiler/linker is missing')
        result[name] = record(file)
    return result


def executable_tool_inputs(node, cli):
    result = {'node': record(Path(node)), 'tauriCliScript': record(cli)}
    for name in ('cargo', 'rustc'):
        actual = Path(subprocess.check_output(['rustup', 'which', name], text=True, encoding='utf-8').strip())
        require(actual.is_file(), 'Rustup compiler binary unavailable')
        result[name] = record(actual)
        if name == 'rustc':
            libraries = actual.parent.parent / 'lib/rustlib' / TARGET / 'lib'
            require(libraries.is_dir(), 'Rust target standard libraries unavailable')
            result['rustTargetLibraries'] = [record(file) for file in sorted(libraries.iterdir()) if file.is_file()]
            result['rustCompilerLibraries'] = [record(file) for file in sorted(actual.parent.glob('rustc_driver-*.dll'))]
            require(result['rustCompilerLibraries'], 'Rust compiler driver library unavailable')
    script = "const r=require('node:module').createRequire(require.resolve('@tauri-apps/cli'));process.stdout.write(r.resolve('@tauri-apps/cli-win32-x64-msvc'))"
    tauri_native = Path(subprocess.check_output([node, '-e', script], cwd=ROOT, text=True, encoding='utf-8').strip())
    result['tauriNative'] = record(tauri_native)
    pnpm = shutil.which('pnpm.cmd')
    require(pnpm, 'pnpm Windows launcher unavailable')
    result['pnpmLauncher'] = record(Path(pnpm))
    return result


def verify_msix(path, app_version, store):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(x.casefold() for x in names)), 'Duplicate MSIX members')
        require('AppxManifest.xml' in names and MAIN in names, 'Incomplete MSIX payload')
        node = ET.fromstring(archive.read('AppxManifest.xml'))
        found = node.find('{' + NS[''] + '}Identity')
        require(found is not None and found.attrib == {'Name': store['name'], 'Publisher': store['publisher'],
                'Version': version(app_version), 'ProcessorArchitecture': 'x64'}, 'MSIX identity drift')
        require(not any(x.lower().endswith(('uninstall.exe', 'setup.exe', '.sig')) for x in names),
                'NSIS/update artifacts cannot enter the Store package')
        return [{'path': name, 'bytes': len(archive.read(name)),
                 'sha256': hashlib.sha256(archive.read(name)).hexdigest()}
                for name in sorted(names) if not name.endswith('/')]


def build(args):
    require(os.name == 'nt', 'Packaging requires Windows x64')
    store = identity(args.identity, args.validation)
    source = source_identity(args.reviewed_public_commit, args.validation)
    projection = projection_identity(args.projection_manifest, args.validation)
    output = args.output.resolve()
    require(not output.exists() and not output.is_relative_to(ROOT.parent if ROOT.name == 'app' else ROOT),
            'Choose a fresh output directory outside the source checkout')
    app_version = json.loads((ROOT / 'package.json').read_text())['version']
    version(app_version)
    sdk = makeappx_tool()
    native_inputs = native_tool_inputs()
    node = shutil.which('node.exe')
    require(node, 'Node.js is required')
    cli = ROOT / 'node_modules/@tauri-apps/cli/tauri.js'
    require(cli.is_file(), 'Run pnpm install --frozen-lockfile first')
    output.mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('TAURI_SIGNING_', 'BLOCK_PET_'))}
    env.pop('TAURI_CONFIG', None)
    env.pop('RUSTFLAGS', None)
    rust_flags = ['-C', 'target-feature=+crt-static', '-C', 'link-arg=/Brepro']
    for remap_source, remap_target in [(ROOT, '/block-pet/app'), (ROOT.parent, '/block-pet'),
                           (Path(os.environ.get('CARGO_HOME', str(Path.home() / '.cargo'))), '/cargo'),
                           (Path(os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup'))), '/rustup')]:
        rust_flags.append('--remap-path-prefix=' + str(remap_source) + '=' + remap_target)
    env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(rust_flags)
    # Each channel has its own Cargo output, avoiding feature-contaminated reuse.
    commands = []
    tool_versions = {}
    for label, command in {'node': [node, '--version'], 'cargo': ['cargo', '-V'],
                           'rustc': ['rustc', '-Vv'], 'tauri': [node, str(cli), '--version']}.items():
        tool_versions[label] = subprocess.check_output(command, text=True).strip()
    tool_versions['pnpm'] = subprocess.check_output(['cmd.exe', '/d', '/c', 'pnpm --version'], text=True).strip()
    pinned_tools = {'versions': tool_versions, 'makeappxSha256': digest(sdk), 'nativeInputs': native_inputs,
                    'executables': executable_tool_inputs(node, cli)}
    if not args.validation:
        require(args.tool_lock is not None, 'Reviewed exact tool-lock JSON is required for a local release build')
        require(json.loads(args.tool_lock.read_text(encoding='utf-8')) == pinned_tools, 'Release tool inputs differ from lock')
    write(output / 'observed-tool-lock.json', pinned_tools)
    outputs, payloads = {}, {}
    for channel in ('github', 'store'):
        target = output / ('target-' + channel)
        env['CARGO_TARGET_DIR'] = str(target)
        for key in ('DMELOPER_STORE_IDENTITY_NAME', 'DMELOPER_STORE_PUBLISHER', 'DMELOPER_STORE_PRODUCT_ID'):
            env.pop(key, None)
        if channel == 'store':
            env.update(DMELOPER_STORE_IDENTITY_NAME=store['name'], DMELOPER_STORE_PUBLISHER=store['publisher'],
                       DMELOPER_STORE_PRODUCT_ID=store['storeProductId'])
        command = [node, str(cli), 'build', '--ci', '--target', TARGET, '--no-bundle',
                   '--features', 'channel-' + channel,
                   '--config', str(ROOT / f'src-tauri/tauri.{channel}.conf.json'), '--', '--locked', '--no-default-features']
        run(command, env, output / ('build-' + channel + '.log'))
        assert_source_state(source['publicCommit'], 'after ' + channel + ' native build')
        commands.append([Path(x).name if str(ROOT) in x else x for x in command])
        binary = target / TARGET / 'release' / MAIN
        require(binary.is_file(), 'Expected channel executable missing')
        screen_private_paths(binary.read_bytes(), [ROOT, ROOT.parent, Path.home(),
            Path(os.environ.get('CARGO_HOME', str(Path.home() / '.cargo'))),
            Path(os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')))])
        if channel == 'github':
            payloads['githubCompiled'] = record(binary)
            expected_image = expected_nsis_image(binary.read_bytes(), tool_versions['tauri'])
            sys.path.insert(0, str(ROOT / 'tools'))
            import prepare_installer_toolchain as nsis
            tools = nsis.prepare(output, target)
            config = output / 'bundle-config.json'
            write(config, {'bundle': {'useLocalToolsDir': True,
                'windows': {'certificateThumbprint': None, 'signCommand': None}}})
            run([node, str(cli), 'bundle', '--ci', '--target', TARGET, '--bundles', 'nsis',
                 '--config', str(ROOT / 'src-tauri/tauri.github.conf.json'), '--config', str(config)],
                env, output / 'bundle-github.log')
            assert_source_state(source['publicCommit'], 'after GitHub NSIS bundle')
            nsis.verify_unchanged(target, tools)
            require(record(binary) == payloads['githubCompiled'], 'Tauri did not restore the compiled image')
            require('Failed to add bundler type' not in (output / 'bundle-github.log').read_text(encoding='utf-8'),
                    'Tauri failed to apply the expected NSIS transformation')
            packaged = output / NSIS_PAYLOAD_DIRECTORY / MAIN
            packaged.parent.mkdir()
            packaged.write_bytes(expected_image)
            payloads['github'] = record(packaged)
            installers = list((target / TARGET / 'release/bundle/nsis').glob('*_x64-setup.exe'))
            require(len(installers) == 1, 'Expected exactly one NSIS output')
            final = output / f'dmelopers-block-pet_{app_version}_x64-setup.exe'
            shutil.copyfile(installers[0], final)
            outputs['github'] = record(final)
        else:
            payloads[channel] = record(binary)
            stage = output / 'msix-stage'
            stage.mkdir()
            shutil.copyfile(binary, stage / MAIN)
            for relative in json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())['bundle']['resources']:
                destination = stage / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / 'src-tauri' / relative, destination)
            icons = output / 'store-icons'
            run([node, str(cli), 'icon', str(ROOT / 'public/logo.png'), '--output', str(icons)],
                env, output / 'store-icons.log')
            (stage / 'StoreAssets').mkdir()
            for name in ('StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png'):
                shutil.copyfile(icons / name, stage / 'StoreAssets' / name)
            (stage / 'AppxManifest.xml').write_bytes(manifest(store, app_version))
            final = output / f'dmelopers-block-pet_{app_version}_x64.msix'
            run([str(sdk), 'pack', '/d', str(stage), '/p', str(final), '/o'], env, output / 'makeappx.log')
            payloads['msixMembers'] = verify_msix(final, app_version, store)
            outputs['storeSubmittedPackage'] = record(final)
    assert_source_state(source['publicCommit'], 'after both packages')
    receipt = {'schemaVersion': 1, 'kind': 'block-pet-dual-channel-build', **source,
        'version': app_version, 'storeVersion': version(app_version), 'storeIdentity': store,
        'projection': projection, 'toolLock': record(output / 'observed-tool-lock.json'),
        'tools': tool_versions, 'makeappx': record(sdk), 'commands': commands,
        'rustFlags': rust_flags,
        'installerToolchain': record(output / 'installer-toolchain.json'),
        'inputs': {name: digest(ROOT / name) for name in ('Cargo.lock', 'pnpm-lock.yaml',
                   'src-tauri/tauri.conf.json', 'src-tauri/tauri.github.conf.json',
                   'src-tauri/tauri.store.conf.json', 'src-tauri/update-trust.json',
                   'src-tauri/windows/github-installer.nsi', 'scripts/packaging/package.py')},
        'outputs': outputs, 'payloads': payloads, 'ciByteIdentityClaimed': False,
        'nativePrivatePathsScreened': True,
        'authenticode': 'absent', 'storeInstalledIdentity': None,
        'remainingGates': ['Tauri detached signature', 'security evidence', 'installed verification',
            'Store Private audience owner verification', 'Store Public hold', 'GitHub frozen draft',
            'Store actual target installability', 'owner joint publication approval', 'signed feed activation']}
    write(output / 'build-receipt.json', receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--reviewed-public-commit', required=True)
    parser.add_argument('--identity', type=Path)
    parser.add_argument('--projection-manifest', type=Path)
    parser.add_argument('--tool-lock', type=Path)
    parser.add_argument('--validation', action='store_true')
    args = parser.parse_args()
    try:
        result = build(args)
        print(json.dumps({'status': 'BUILT', 'purpose': result['purpose'], 'outputs': result['outputs']}, indent=2))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'Packaging blocked: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
