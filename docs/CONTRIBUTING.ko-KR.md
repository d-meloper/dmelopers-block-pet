# 기여 안내

이 저장소는 독립 개인 프로젝트 DMeloper's Block Pet의 단독 빌드 가능한 공개 소스입니다. 제안은 검토 후 원본에 반영하고 공개 소스를 다시 만듭니다. 라이선스와 자산 출처를 보존하고 인증 정보·개인 경로·사용자 데이터·빌드 결과를 포함하지 마세요.

## 빌드 및 검사

Windows 11 24H2 이상 x64, Node.js 24, pnpm 11.15.1, Rust MSVC, Visual Studio C++ Build Tools, Windows SDK 10.0.26100.0 이상이 필요합니다. 일반 PowerShell의 `app/`에서 실행합니다. 빌드 래퍼가 유니코드 프로필 경로를 보존하며 x64 도구 환경을 설정합니다.

```powershell
pnpm install --frozen-lockfile
python -m unittest discover -s scripts/packaging -p test_*.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/build.ps1 --validation --reviewed-public-commit (git rev-parse HEAD) --output C:/BlockPetBuild/validation-001
```

변경 없는 커밋된 소스와 저장소 밖의 새 출력 폴더를 사용합니다. GitHub NSIS와 Store MSIX를 빌드하고 MSIX manifest를 검사하며 소스·도구·입력·출력 정보를 기록합니다. 검사 전용 Store 식별자는 가상 값이며 실제 제출용으로 사용할 수 없습니다. `scripts/packaging/store-identity.example.json`의 Partner Center 등록 필수 값이 비어 있으면 실제 빌드를 차단합니다.

공개 CI는 두 패키지를 검사하지만 바이너리·빌드 아티팩트·바이너리가 든 공개 캐시를 업로드하지 않습니다. CI 성공은 로컬 릴리스와의 바이트 일치를 증명하지 않습니다. 실제 후보는 검토된 공개 커밋, 보존한 소스 내보내기 명세, 등록한 Store 식별자 및 정확한 도구 잠금 정보를 이용해 로컬에서 생성합니다. 이후 서명·보안·설치·공동 게시 검증이 필요합니다. 공개 앱 빌드에 비공개 harness는 필요하지 않습니다.

Store는 packagedClassicApp·mediumIL·runFullTrust·StartupTask와 사용 중 업데이트 지연을 선언하며 Windows 빌드 26100 이상을 요구합니다. Microsoft가 서명한 설치 결과의 식별자·payload는 제출 파일 SHA-256과 따로 검증합니다. Microsoft의 [패키지 manifest 안내](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-manual-conversion)와 [업데이트 지연 문서](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-uap17-updatewhileinuse)를 참고하세요.

소스 변경 승인은 게시 승인이 아닙니다. 운영자가 작성하는 이슈·PR 본문은 영문 전체 다음 한국어 전체로 작성합니다.
