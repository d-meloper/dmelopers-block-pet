#!/usr/bin/env python3
"""Standalone Windows package builder. Never publishes or modifies installed data.

Use build.ps1 to activate the Visual Studio x64 tools. Validation builds use a clearly
synthetic Store identity; only local builds from a reviewed, clean public commit
can carry release provenance. Receipts prove inputs, not reproducible CI bytes.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import struct
import tempfile
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
TARGET = 'x86_64-pc-windows-msvc'
MAIN = 'dmelopers-block-pet.exe'
# Partner Center's reserved name; a channel suffix is not another reservation.
STORE_DISPLAY_NAME = "DMeloper's Block Pet"
MINIMUM_WINDOWS_VERSION = '10.0.19045.3448'
MAXIMUM_WINDOWS_VERSION_TESTED = '10.0.26100.0'
STORE_BUILD_SCHEMA = 2
STORE_TARGET_SIZES = (16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256)
STORE_BASE_ASSETS = {'StoreLogo.png': 50, 'Square150x150Logo.png': 150, 'Square44x44Logo.png': 44}
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
    add(properties, 'DisplayName', text=STORE_DISPLAY_NAME)
    add(properties, 'PublisherDisplayName', text='DMeloper')
    add(properties, 'Logo', text='StoreAssets\\StoreLogo.png')
    add(properties, 'uap17:UpdateWhileInUse', text='defer')
    dependencies = add(package, 'Dependencies')
    add(dependencies, 'TargetDeviceFamily', {'Name': 'Windows.Desktop', 'MinVersion': MINIMUM_WINDOWS_VERSION,
                                           'MaxVersionTested': MAXIMUM_WINDOWS_VERSION_TESTED})
    resources = add(package, 'Resources')
    for language in ('en-US', 'ko-KR'):
        add(resources, 'Resource', {'Language': language})
    apps = add(package, 'Applications')
    app = add(apps, 'Application', {'Id': 'App', 'Executable': MAIN,
        tag('uap10:RuntimeBehavior'): 'packagedClassicApp', tag('uap10:TrustLevel'): 'mediumIL'})
    add(app, 'uap:VisualElements', {'DisplayName': STORE_DISPLAY_NAME, 'Description': 'Desktop pet',
        'BackgroundColor': 'transparent', 'Square150x150Logo': 'StoreAssets\\Square150x150Logo.png',
        'Square44x44Logo': 'StoreAssets\\Square44x44Logo.png'})
    extensions = add(app, 'Extensions')
    extension = add(extensions, 'desktop:Extension', {'Category': 'windows.startupTask',
        'Executable': MAIN, 'EntryPoint': 'Windows.FullTrustApplication'})
    add(extension, 'desktop:StartupTask', {'TaskId': 'BlockPetStartup', 'Enabled': 'false',
                                         'DisplayName': STORE_DISPLAY_NAME})
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


def makepri_tool(makeappx):
    """Use the same selected SDK/architecture; no independent tool fallback."""
    path = Path(makeappx).with_name('makepri.exe')
    require(path.is_file(), 'Selected Windows SDK MakePri x64 is required')
    return path.resolve(strict=True)


def store_asset_sizes():
    assets = dict(STORE_BASE_ASSETS)
    for size in STORE_TARGET_SIZES:
        for suffix in ('', '_altform-unplated', '_altform-lightunplated'):
            assets[f'Square44x44Logo.targetsize-{size}{suffix}.png'] = size
    return assets


def verify_store_png(data, size):
    """Validate the generator's RGBA8 PNG contract and actual transparent pixels."""
    require(data[:8] == b'\x89PNG\r\n\x1a\n', 'Invalid Store icon PNG')
    offset, compressed, header, ended = 8, bytearray(), None, False
    while offset + 12 <= len(data):
        length = struct.unpack_from('>I', data, offset)[0]
        require(offset + length + 12 <= len(data), 'Truncated Store icon PNG')
        tag = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + length]
        crc = struct.unpack_from('>I', data, offset + 8 + length)[0]
        require(zlib.crc32(tag + chunk) == crc, 'Store icon PNG checksum differs')
        if tag == b'IHDR':
            require(header is None and offset == 8, 'Invalid Store icon PNG header')
            header = chunk
        elif tag == b'IDAT':
            compressed.extend(chunk)
        elif tag == b'IEND':
            ended = length == 0
            offset += length + 12
            break
        offset += length + 12
    require(ended and offset == len(data) and header == struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0),
            'Store icon must have its exact dimensions and RGBA8 format')
    expected = size * (size * 4 + 1)
    decoder = zlib.decompressobj()
    try:
        raw = decoder.decompress(compressed, expected + 1)
    except zlib.error as error:
        raise ValueError('Invalid Store icon PNG compression') from error
    require(len(raw) == expected and decoder.eof and not decoder.unused_data,
            'Invalid Store icon PNG pixels')
    previous = bytearray(size * 4)
    alpha = set()
    for row in range(size):
        start = row * (size * 4 + 1)
        filter_type = raw[start]
        require(filter_type <= 4, 'Invalid Store icon PNG filter')
        current = bytearray(raw[start + 1:start + 1 + size * 4])
        for i in range(len(current)):
            left, up, upper_left = (current[i - 4] if i >= 4 else 0), previous[i], (previous[i - 4] if i >= 4 else 0)
            if filter_type == 1: prediction = left
            elif filter_type == 2: prediction = up
            elif filter_type == 3: prediction = (left + up) // 2
            elif filter_type == 4:
                estimate = left + up - upper_left
                prediction = min((left, up, upper_left), key=lambda x: abs(estimate - x))
            else: prediction = 0
            current[i] = (current[i] + prediction) & 255
        alpha.update(current[3::4])
        previous = current
    require(0 in alpha and max(alpha) > 0, 'Store icon must retain transparent exterior and visible artwork')


def verify_store_pri_dump(data, store):
    root = ET.fromstring(data)
    maps = root.findall('ResourceMap')
    require(len(maps) == 1 and maps[0].get('name') == store['name']
            and maps[0].get('primary') == 'true', 'Store PRI identity differs')
    resources = maps[0].findall('.//NamedResource')
    expected = {f'ms-resource://{store["name"]}/Files/StoreAssets/{name}': name for name in STORE_BASE_ASSETS}
    require(len(resources) == len(expected) and {item.get('uri') for item in resources} == set(expected),
            'Store PRI logical resources differ')
    for resource in resources:
        name = expected[resource.get('uri')]
        wanted = {('StoreAssets/' + name, ())}
        if name == 'Square44x44Logo.png':
            for size in STORE_TARGET_SIZES:
                for suffix, form in (('', None), ('_altform-unplated', 'UNPLATED'), ('_altform-lightunplated', 'LIGHTUNPLATED')):
                    qualifiers = [('TargetSize', str(size))]
                    if form: qualifiers.append(('AlternateForm', form))
                    wanted.add((f'StoreAssets/Square44x44Logo.targetsize-{size}{suffix}.png', tuple(sorted(qualifiers))))
        actual = []
        for candidate in resource.findall('Candidate'):
            require(candidate.get('type') == 'Path', 'Store PRI candidate is not a path')
            qualifiers = tuple(sorted((q.get('name'), q.get('value')) for q in candidate.findall('QualifierSet/Qualifier')))
            actual.append(((candidate.findtext('Value') or '').replace('\\', '/'), qualifiers))
        require(len(actual) == len(wanted) and set(actual) == wanted, 'Missing, invalid or duplicate Store PRI candidate')


def verify_store_resources(stage, store, makepri, environment, log, dump):
    assets = stage / 'StoreAssets'
    require(assets.is_dir() and {x.name for x in assets.iterdir()} == set(store_asset_sizes()),
            'Missing or unexpected Store icon assets')
    for name, size in store_asset_sizes().items():
        verify_store_png((assets / name).read_bytes(), size)
    require((stage / 'resources.pri').is_file(), 'Store resources.pri is missing')
    run([str(makepri), 'dump', '/if', str(stage / 'resources.pri'), '/of', str(dump), '/dt', 'detailed'], environment, log)
    verify_store_pri_dump(dump.read_bytes(), store)
    return {'logoSha256': digest(ROOT / 'public/logo.png'), 'makepri': record(makepri),
            'pri': record(stage / 'resources.pri'), 'dump': record(dump),
            'assets': [record(assets / name) for name in sorted(store_asset_sizes())]}


def generate_store_resources(stage, output, store, node, cli, makepri, environment):
    icons, targets = output / 'store-icons', output / 'store-target-icons'
    logo = ROOT / 'public/logo.png'
    run([node, str(cli), 'icon', str(logo), '--output', str(icons)], environment, output / 'store-icons.log')
    custom = [node, str(cli), 'icon', str(logo), '--output', str(targets)]
    for size in STORE_TARGET_SIZES: custom.extend(['--png', str(size)])
    run(custom, environment, output / 'store-target-icons.log')
    # Resource-only root keeps executable/manifest/config/log files out of the PRI.
    resources = output / 'store-resource-stage'
    assets = resources / 'StoreAssets'
    assets.mkdir(parents=True)
    for name, size in store_asset_sizes().items():
        shutil.copyfile(icons / name if name in STORE_BASE_ASSETS else targets / f'{size}x{size}.png', assets / name)
    config = output / 'priconfig.xml'
    run([str(makepri), 'createconfig', '/cf', str(config), '/dq', 'en-US'], environment, output / 'makepri-config.log')
    tree = ET.parse(config)
    # All target/alternate-form assets belong to the single main package.
    tree.getroot().remove(tree.getroot().find('packaging'))
    tree.write(config, encoding='utf-8', xml_declaration=True)
    run([str(makepri), 'new', '/pr', str(resources), '/cf', str(config),
         '/mn', str(stage / 'AppxManifest.xml'), '/of', str(resources / 'resources.pri')], environment, output / 'makepri.log')
    evidence = verify_store_resources(resources, store, makepri, environment,
                                      output / 'makepri-dump.log', output / 'resources.pri.xml')
    evidence['config'] = record(config)
    shutil.copytree(assets, stage / 'StoreAssets')
    shutil.copyfile(resources / 'resources.pri', stage / 'resources.pri')
    return evidence


def verify_msix_store_resources(path, store, makepri, environment, log, dump):
    with tempfile.TemporaryDirectory(prefix='block-pet-store-resources-') as temporary:
        stage = Path(temporary)
        with zipfile.ZipFile(path) as archive:
            expected = {'StoreAssets/' + name for name in store_asset_sizes()} | {'resources.pri'}
            actual = {name for name in archive.namelist() if name.startswith('StoreAssets/') or name == 'resources.pri'}
            require(actual == expected, 'Missing or unexpected packaged Store resources')
            for name in expected:
                destination = stage / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(name))
        return verify_store_resources(stage, store, makepri, environment, log, dump)


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


def verify_msix(path, app_version, store, *, expected_minimum_windows=None):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(x.casefold() for x in names)), 'Duplicate MSIX members')
        require('AppxManifest.xml' in names and MAIN in names, 'Incomplete MSIX payload')
        node = ET.fromstring(archive.read('AppxManifest.xml'))
        found = node.find('{' + NS[''] + '}Identity')
        require(found is not None and found.attrib == {'Name': store['name'], 'Publisher': store['publisher'],
                'Version': version(app_version), 'ProcessorArchitecture': 'x64'}, 'MSIX identity drift')
        if expected_minimum_windows is not None:
            display = node.find('{' + NS[''] + '}Properties/{' + NS[''] + '}DisplayName')
            visual = node.find('.//{' + NS['uap'] + '}VisualElements')
            startup = node.find('.//{' + NS['desktop'] + '}StartupTask')
            require(display is not None and display.text == STORE_DISPLAY_NAME
                    and visual is not None and visual.get('DisplayName') == STORE_DISPLAY_NAME
                    and startup is not None and startup.get('DisplayName') == STORE_DISPLAY_NAME,
                    'MSIX display names must match the reserved Store product name')
            family = node.find('{' + NS[''] + '}Dependencies/{' + NS[''] + '}TargetDeviceFamily')
            require(family is not None and family.attrib == {'Name': 'Windows.Desktop',
                    'MinVersion': expected_minimum_windows,
                    'MaxVersionTested': MAXIMUM_WINDOWS_VERSION_TESTED}, 'MSIX Windows requirements drift')
            defer = node.find('{' + NS[''] + '}Properties/{' + NS['uap17'] + '}UpdateWhileInUse')
            require(defer is not None and defer.text == 'defer'
                    and 'uap17' in node.get('IgnorableNamespaces', '').split(),
                    'MSIX update deferral must remain optional on older supported Windows')
        require(not any(x.lower().endswith(('uninstall.exe', 'setup.exe', '.sig')) for x in names),
                'Installer/update artifacts cannot enter the Store package')
        return [{'path': name, 'bytes': len(archive.read(name)),
                 'sha256': hashlib.sha256(archive.read(name)).hexdigest()}
                for name in sorted(names) if not name.endswith('/')]


def checked_cache_path(path):
    path = Path(path)
    require(path.is_absolute(), 'Compiler cache must use an absolute path')
    for item in (path, *path.parents):
        if os.path.lexists(item):
            require(not item.is_symlink() and not (getattr(item.lstat(), 'st_file_attributes', 0) & 0x400),
                    'Compiler cache cannot traverse a reparse point')
    return path.resolve()


@contextmanager
def compiler_cache(path, output):
    if path is None:
        yield None
        return
    root = checked_cache_path(path)
    source = ROOT.parent if ROOT.name == 'app' else ROOT
    output = Path(output).resolve()
    require(not root.is_relative_to(source.resolve()) and not source.resolve().is_relative_to(root),
            'Compiler cache must be separate from source')
    require(not root.is_relative_to(output) and not output.is_relative_to(root),
            'Compiler cache and candidate output must be separate')
    root.mkdir(parents=True, exist_ok=True)
    lock_path = checked_cache_path(root / '.build.lock')
    with lock_path.open('a+b') as lock:
        lock.seek(0, os.SEEK_END)
        if lock.tell() == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        import msvcrt
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise ValueError('Compiler cache is already in use') from error
        try:
            yield root
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def cache_target(root, channel, tools, flags, store):
    require(channel in ('github', 'store'), 'Unsupported compiler cache channel')
    inputs = {'contract': 1, 'target': TARGET, 'channel': channel, 'tools': tools,
              'flags': flags, 'storeIdentity': store if channel == 'store' else None}
    key = hashlib.sha256(json.dumps(inputs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return checked_cache_path(root / (channel + '-' + key))


def build(args):
    with compiler_cache(getattr(args, 'cache_root', None), args.output) as cache:
        return build_packages(args, cache)


def build_packages(args, cache):
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
    makepri = makepri_tool(sdk)
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
    pinned_tools = {'versions': tool_versions, 'makeappxSha256': digest(sdk), 'nativeInputs': native_inputs, 'makepriSha256': digest(makepri),
                    'executables': executable_tool_inputs(node, cli)}
    if not args.validation:
        require(args.tool_lock is not None, 'Reviewed exact tool-lock JSON is required for a local release build')
        require(json.loads(args.tool_lock.read_text(encoding='utf-8')) == pinned_tools, 'Release tool inputs differ from lock')
    write(output / 'observed-tool-lock.json', pinned_tools)
    outputs, payloads = {}, {}
    for channel in ('store',):
        target = cache_target(cache, channel, pinned_tools, rust_flags, store) if cache else output / ('target-' + channel)
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
        compiled = target / TARGET / 'release' / MAIN
        require(compiled.is_file(), 'Expected channel executable missing')
        # Retained payloads and packaging tools never live in the mutable compiler cache.
        target = output / ('target-' + channel)
        binary = target / TARGET / 'release' / MAIN
        if compiled != binary:
            binary.parent.mkdir(parents=True)
            shutil.copyfile(compiled, binary)
        env['CARGO_TARGET_DIR'] = str(target)
        screen_private_paths(binary.read_bytes(), [ROOT, ROOT.parent, Path.home(),
            Path(os.environ.get('CARGO_HOME', str(Path.home() / '.cargo'))),
            Path(os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')))])
        payloads[channel] = record(binary)
        stage = output / 'msix-stage'
        stage.mkdir()
        shutil.copyfile(binary, stage / MAIN)
        for relative in json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())['bundle']['resources']:
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / 'src-tauri' / relative, destination)
        (stage / 'AppxManifest.xml').write_bytes(manifest(store, app_version))
        store_resources = generate_store_resources(stage, output, store, node, cli, makepri, env)
        final = output / f'dmelopers-block-pet_{app_version}_x64.msix'
        run([str(sdk), 'pack', '/d', str(stage), '/p', str(final), '/o'], env, output / 'makeappx.log')
        payloads['msixMembers'] = verify_msix(final, app_version, store,
                expected_minimum_windows=MINIMUM_WINDOWS_VERSION)
        packaged_resources = verify_msix_store_resources(final, store, makepri, env,
                output / 'makepri-package-dump.log', output / 'packaged-resources.pri.xml')
        require(packaged_resources['pri'] == store_resources['pri']
                and packaged_resources['assets'] == store_resources['assets'], 'Packaged Store resources differ')
        outputs['storeSubmittedPackage'] = record(final)
    assert_source_state(source['publicCommit'], 'after Store package')
    receipt = {'schemaVersion': STORE_BUILD_SCHEMA, 'kind': 'block-pet-store-build', **source,
        'version': app_version, 'storeVersion': version(app_version), 'storeIdentity': store,
        'projection': projection, 'toolLock': record(output / 'observed-tool-lock.json'),
        'tools': tool_versions, 'makeappx': record(sdk), 'commands': commands,
        'storeResources': store_resources,
        'rustFlags': rust_flags,
        'inputs': {name: digest(ROOT / name) for name in ('Cargo.lock', 'pnpm-lock.yaml',
                   'src-tauri/tauri.conf.json', 'src-tauri/tauri.github.conf.json',
                   'src-tauri/tauri.store.conf.json', 'src-tauri/update-trust.json',
                   'scripts/packaging/package.py')},
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
    parser.add_argument('--cache-root', type=Path, help='Optional external compiler cache; exclusively locked and channel/tool separated')
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
