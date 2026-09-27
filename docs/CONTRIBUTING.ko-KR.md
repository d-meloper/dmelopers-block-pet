# 기여 안내

공개 저장소는 검토한 앱 소스의 배포본입니다. 이슈와 변경 제안을 검토한 뒤 원본에 반영하여 다시 내보냅니다.

Windows 11 24H2 이상 x64를 지원합니다. 다른 운영체제 지원은 해당 환경의 구현과 검증이 필요합니다.

- 기존 이슈를 먼저 검색하고 한 가지 문제나 변경을 설명해 주세요.
- 개인정보, 인증 정보, 빌드 결과, 재배포 권리가 확인되지 않은 자산을 첨부하지 마세요.
- 새 코드·이미지·모델의 출처와 라이선스를 기록하고 기존 저작권 고지를 보존해 주세요.

개발에는 Node.js, pnpm, Rust MSVC, Visual Studio C++ Build Tools와 Windows SDK, WebView2가 필요합니다. `app/`에서 실행합니다.

```powershell
pnpm install --frozen-lockfile
pnpm build
cargo check --locked --manifest-path src-tauri/Cargo.toml
rustup target add i686-pc-windows-msvc
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-package'
$env:RUSTFLAGS = '-C target-feature=+crt-static -C link-arg=/Brepro'
cargo build --locked --release --target x86_64-pc-windows-msvc -p block-pet-update-core --bin block-pet-update-worker
pnpm exec tauri build --target x86_64-pc-windows-msvc --no-bundle -- --locked
python tools/build_installer_utils.py --target-dir "$env:CARGO_TARGET_DIR/installer-utils" --output-dir "$env:CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release"
python tools/prepare_installer_toolchain.py --evidence-dir "$env:CARGO_TARGET_DIR/installer-tool-evidence" --target-dir "$env:CARGO_TARGET_DIR"
$bundleConfig = "$env:CARGO_TARGET_DIR/installer-tool-evidence/bundle-config.json"
@{bundle=@{useLocalToolsDir=$true}} | ConvertTo-Json | Set-Content -LiteralPath $bundleConfig -Encoding utf8
pnpm exec tauri bundle --target x86_64-pc-windows-msvc --bundles nsis --config "$bundleConfig"
```

패키징에는 새 `target-package` 디렉터리와 Visual Studio 개발자 셸을 사용합니다.
worker를 먼저 빌드하면 앱이 정확한 해시와 크기를 결속합니다. 도구 준비기는
고정된 공식 NSIS 3.12 압축본을 검증하고 입력을 보존하며, 별도 3개 명령 플러그인은
원본 라이선스를 유지합니다. 로컬 빌드만으로 배포가 승인되지는 않습니다.

운영자가 작성하는 이슈·PR 본문은 영문 전체 다음 한국어 전체 순서입니다. 제안 수락만으로 릴리즈가 승인되지는 않으며 공개 소스, 설치 후보와 게시에는 각각 검증이 필요합니다.
