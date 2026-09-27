"""Build the purpose-limited Unicode x86 NSIS plugin with explicit MSVC tools.

Does not install tools, change global caches, or build/install the application.
An optional external sysroot supplies a separately verified i686 rust-std.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CRATE = ROOT / "src-tauri/windows/installer-utils"


def pe_inventory(path):
    data = Path(path).read_bytes()
    if data[:2] != b"MZ":
        raise ValueError("plugin has no DOS header")
    pe = struct.unpack_from("<I", data, 60)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("plugin has no PE header")
    machine, count = struct.unpack_from("<HH", data, pe + 4)
    optional = pe + 24
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    magic = struct.unpack_from("<H", data, optional)[0]
    directories = optional + (96 if magic == 0x10B else 112)
    sections = [struct.unpack_from("<8sIIIIIIHHI", data, optional + optional_size + i * 40)
                for i in range(count)]

    def offset(rva):
        for section in sections:
            if section[2] <= rva < section[2] + max(section[1], section[3]):
                return section[4] + rva - section[2]
        raise ValueError(f"PE RVA outside sections: {rva}")

    def string(rva):
        start = offset(rva)
        return data[start:data.index(0, start)].decode("ascii")

    exports = []
    export_rva = struct.unpack_from("<I", data, directories)[0]
    if export_rva:
        table = struct.unpack_from("<IIHHIIIIIII", data, offset(export_rva))
        names = offset(table[9])
        exports = [string(struct.unpack_from("<I", data, names + i * 4)[0])
                   for i in range(table[7])]
    imports = {}
    import_rva = struct.unpack_from("<I", data, directories + 8)[0]
    if import_rva:
        cursor = offset(import_rva)
        while True:
            thunk, timestamp, chain, name, first = struct.unpack_from("<IIIII", data, cursor)
            if not any((thunk, timestamp, chain, name, first)):
                break
            symbols = []
            lookup = offset(thunk or first)
            width = 4 if magic == 0x10B else 8
            while True:
                value = int.from_bytes(data[lookup:lookup + width], "little")
                if not value:
                    break
                symbols.append(f"ordinal:{value & 0xffff}" if value >> (width * 8 - 1)
                               else string(value + 2))
                lookup += width
            imports[string(name)] = symbols
            cursor += 20
    return {"machine": hex(machine), "exports": sorted(exports), "imports": imports,
            "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def tool_environment(sysroot=None):
    env = os.environ.copy()
    # Do not inherit unrelated cross-compilation flags from an app build.
    for key in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
                "CARGO_TARGET_I686_PC_WINDOWS_MSVC_RUSTFLAGS",
                "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS"):
        env.pop(key, None)
    program_files = Path(env["PROGRAMFILES(X86)"])
    vswhere = program_files / "Microsoft Visual Studio/Installer/vswhere.exe"
    found = subprocess.check_output([
        str(vswhere), "-latest", "-products", "*", "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath",
    ], text=True).strip()
    if not found:
        raise RuntimeError("MSVC x86/x64 C++ tools are unavailable")
    candidates = Path(found) / "VC/Tools/MSVC"
    vc = max((p for p in candidates.iterdir() if (p / "lib/x86/libcmt.lib").is_file()
              and (p / "lib/x64/msvcrt.lib").is_file()), key=lambda p: tuple(map(int, p.name.split('.'))))
    sdk = max((p for p in (program_files / "Windows Kits/10/Lib").iterdir()
               if (p / "um/x86/kernel32.lib").is_file() and (p / "ucrt/x64/ucrt.lib").is_file()),
              key=lambda p: tuple(map(int, p.name.split('.'))))
    host_lib = [vc / "lib/x64", sdk / "ucrt/x64", sdk / "um/x64"]
    target_lib = [vc / "lib/x86", sdk / "ucrt/x86", sdk / "um/x86"]
    env["LIB"] = os.pathsep.join(map(str, host_lib))
    env["CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER"] = str(vc / "bin/Hostx64/x64/link.exe")
    env["CARGO_TARGET_I686_PC_WINDOWS_MSVC_LINKER"] = str(vc / "bin/Hostx64/x86/link.exe")
    flags = ["-C", "target-feature=+crt-static"]
    for library in target_lib:
        flags += ["-L", "native=" + str(library)]
    if sysroot:
        flags += ["--sysroot", str(Path(sysroot).resolve())]
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(flags)
    return env, {"msvc": str(vc), "windowsSdk": str(sdk), "sysroot": str(sysroot) if sysroot else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sysroot", type=Path)
    args = parser.parse_args()
    args.target_dir = args.target_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    env, configuration = tool_environment(args.sysroot)
    command = ["cargo", "build", "--manifest-path", str(CRATE / "Cargo.toml"), "--locked",
               "--release", "--target", "i686-pc-windows-msvc", "--target-dir", str(args.target_dir)]
    completed = subprocess.run(command, env=env, capture_output=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "installer-utils-build.stdout.log").write_bytes(completed.stdout)
    (args.output_dir / "installer-utils-build.stderr.log").write_bytes(completed.stderr)
    if completed.returncode:
        raise SystemExit(f"plugin build failed ({completed.returncode}); see output-dir logs")
    # Rust's cdylib mode exports no_mangle allocator/entrypoint support symbols
    # as well. Link its static library with an explicit DEF so NSIS sees only
    # the three reviewed commands, without modifying the resulting PE bytes.
    library = args.target_dir / "i686-pc-windows-msvc/release/block_pet_installer_utils.lib"
    built = args.output_dir / "block_pet_installer_utils.dll"
    vc, sdk = Path(configuration["msvc"]), Path(configuration["windowsSdk"])
    link_command = [str(vc / "bin/Hostx64/x86/link.exe"), "/NOLOGO", "/DLL", "/MACHINE:X86",
                    "/INCREMENTAL:NO", "/OPT:REF,ICF", "/DYNAMICBASE", "/NXCOMPAT", "/Brepro",
                    "/ENTRY:DllMain", f"/DEF:{CRATE / 'exports.def'}", f"/OUT:{built}", str(library),
                    f"/LIBPATH:{vc / 'lib/x86'}", f"/LIBPATH:{sdk / 'ucrt/x86'}",
                    f"/LIBPATH:{sdk / 'um/x86'}", "libcmt.lib"]
    linked = subprocess.run(link_command, env=env, capture_output=True)
    (args.output_dir / "installer-utils-link.stdout.log").write_bytes(linked.stdout)
    (args.output_dir / "installer-utils-link.stderr.log").write_bytes(linked.stderr)
    if linked.returncode:
        raise SystemExit(f"plugin link failed ({linked.returncode}); see output-dir logs")
    inventory = pe_inventory(built)
    expected = {"FindProcess", "RunAsUser", "SemverCompare"}
    if inventory["machine"] != "0x14c" or expected != set(inventory["exports"]):
        raise RuntimeError(f"unexpected NSIS plugin architecture/exports: {inventory}")
    forbidden = {"TerminateProcess", "OpenThread", "TerminateThread"}
    imported = {symbol for symbols in inventory["imports"].values() for symbol in symbols}
    if imported & forbidden:
        raise RuntimeError("plugin imports a removed process-control API")
    allowed_dlls = {"kernel32.dll", "user32.dll", "advapi32.dll", "shell32.dll"}
    if set(map(str.lower, inventory["imports"])) - allowed_dlls:
        raise RuntimeError("plugin imports an unreviewed DLL or external CRT before prerequisites")
    inputs = [*CRATE.rglob("*.rs"), *CRATE.rglob("Cargo.toml"), CRATE / "Cargo.lock",
              CRATE / "exports.def", CRATE / "upstream-provenance.json", Path(__file__).resolve()]
    record = {"command": command, "exitCode": completed.returncode, "toolchain": configuration,
              "linkCommand": link_command, "linkExitCode": linked.returncode,
              "rustc": subprocess.check_output(["rustc", "-Vv"], text=True),
              "plugin": inventory, "output": str(built),
              "inputs": {str(path.relative_to(ROOT)).replace("\\", "/"):
                         hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(inputs)}}
    (args.output_dir / "installer-utils-build.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(built), **inventory}, ensure_ascii=True))


if __name__ == "__main__":
    main()
