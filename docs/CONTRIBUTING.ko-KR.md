# 기여 안내

한국어 · [English](https://github.com/d-meloper/dmelopers-block-pet/blob/main/docs/CONTRIBUTING.md)

## 제안과 수정

문제 제보나 기능 제안은 [GitHub Issues](https://github.com/d-meloper/dmelopers-block-pet/issues)를 이용해 주세요. 무엇을 하려는지, 어떤 점이 불편한지 적어 주세요.

PR에는 문제, 수정 내용과 확인한 방법을 적어 주세요. 관련 없는 변경은 나눠 주세요. 라이선스와 자산 출처는 보존하고, 인증 정보·개인 경로·사용자 데이터·빌드 결과는 포함하지 마세요.

공개 소스만으로 앱을 빌드할 수 있습니다. Microsoft Store 배포는 준비 중입니다. 채택한 수정은 관리 중인 원본에 반영한 뒤 다음 공개 소스 갱신에 포함합니다.

## 빌드에 필요한 도구

- Windows x64; 빌드 환경은 Windows 11 24H2 이상을 권장합니다.
- Node.js 24와 pnpm 11.15.1
- Python 3.11 이상
- Rust MSVC, Visual Studio C++ Build Tools와 Windows SDK 10.0.26100.0 이상

## 빌드와 검사

일반 PowerShell에서 `app/` 폴더로 이동한 뒤 실행하세요. 빌드 스크립트가 x64 도구 환경을 설정하며 유니코드 프로필 경로를 지원합니다.

```powershell
pnpm install --frozen-lockfile
python -m unittest discover -s scripts/packaging -p test_*.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/build.ps1 --validation --reviewed-public-commit (git rev-parse HEAD) --output C:/BlockPetBuild/validation-001
```

모든 변경을 커밋한 소스와 저장소 밖의 새 출력 폴더를 사용하세요. 이 명령은 Store MSIX만 빌드하고 매니페스트를 검사한 뒤 사용한 소스·도구·출력 파일을 기록합니다. 공식 GitHub WiX Burn/MSI 설치파일은 운영자가 검토된 앱 소스의 정확한 상태를 기준으로 로컬에서 만들며, 별도의 정식 빌드 근거와 공식 서명 정보를 사용합니다. 위 명령으로 이 설치파일을 만들지는 않습니다.

`--validation` 빌드는 예시 Store 식별자를 사용하므로 Store에 제출할 수 없습니다. Partner Center에 등록해야 하는 항목은 `scripts/packaging/store-identity.example.json`에 있습니다. 실제 배포 빌드는 필수 값이 비어 있으면 중단됩니다.

로컬에서 반복 빌드할 때는 `--cache-root C:/BlockPetBuild/compiler-cache`를 추가할 수 있습니다. 이 절대 경로는 소스·결과 폴더와 분리하세요. 빌더는 캐시를 잠그고 채널·도구 구성에 따라 컴파일 결과를 분리하며, Store 결과는 새 출력 폴더에 보관합니다. 캐시를 사용해도 결과 파일 검증은 수행합니다.

## 배포 빌드

공개 CI는 정확한 소스 커밋, 허용된 공개 파일과 자산, 비공개 정보 포함 여부를 검사합니다. GitHub에서 의존성 검토를 제공하면 새로 추가한 의존성도 확인합니다. 앱과 Store 패키지 빌드는 로컬에서 검증하며, CI는 바이너리·빌드 결과·바이너리 캐시를 만들거나 업로드하지 않습니다.

Store 배포 파일은 검토한 공개 커밋, 보존한 소스 내보내기 명세, 등록한 Store 식별자와 정확한 도구 버전으로 로컬에서 만듭니다. 이후 서명·보안·설치·게시 검증을 따로 진행합니다. 공개 앱을 빌드하는 데 운영자의 비공개 도구는 필요하지 않습니다.

앱의 최소 환경은 x64 Windows 10 22H2 + 2023년 9월 누적 업데이트(빌드 19045.3448) 또는 Windows 11 22H2 + 2023년 9월 누적 업데이트(빌드 22621.2283)입니다. 위 Windows SDK 요구사항은 빌드 도구 기준이며 앱을 실행하는 Windows의 최소 버전이 아닙니다.

Store 패키지는 `packagedClassicApp`, `mediumIL`, `runFullTrust`, `StartupTask`와 `uap17:UpdateWhileInUse=defer`를 선언합니다. 최소 설치 버전은 `10.0.19045.3448`이며, 앱은 Windows 11의 최소 환경 미달도 별도로 안내합니다. `uap17`을 `IgnorableNamespaces`에 유지하세요. Windows 11 24H2 이상에서는 사용 중 업데이트를 연기하고, 그 이전 지원 버전에서는 해당 Windows의 기본 Store 업데이트 동작을 따릅니다. Microsoft 서명 후 설치된 식별자와 파일은 제출 패키지의 해시와 따로 확인합니다.

Microsoft의 [패키지 매니페스트 안내](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-manual-conversion)와 [업데이트 지연 문서](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-uap17-updatewhileinuse)를 참고하세요.

소스 수정이 반영되어도 배포가 바로 이루어지는 것은 아닙니다. 운영자가 작성하는 이슈·PR 본문은 영어 다음 한국어 순서로 작성합니다.

운영자의 공개 소스 변경은 소스 검사를 통과한 뒤 squash 방식으로 병합합니다.
