# DMeloper's Block Pet

[![Release](https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/release.svg)](https://github.com/d-meloper/dmelopers-block-pet/releases/latest) [![Downloads](https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/downloads.svg)](https://github.com/d-meloper/dmelopers-block-pet/releases) [![Stars](https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/stars.svg)](https://github.com/d-meloper/dmelopers-block-pet/stargazers) [![License](https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/license.svg)](LICENSE)

키보드와 마우스에 반응하며 PNG 스킨, 프리셋, 선택적 OBS 브라우저 출력을 지원하는 Minecraft 스타일 데스크톱 펫입니다.

Windows 11 24H2 이상 x64를 지원합니다.

[공식 Releases 페이지](https://github.com/d-meloper/dmelopers-block-pet/releases)에서 설치 EXE와 `.sig` 파일을 받으세요.

Edge의 **“일반적으로 다운로드되지 않습니다”**는 다운로드 평판 경고이며, 이 문구만으로 악성코드 탐지를 뜻하지는 않습니다. 파일의 안전성을 보증하는 문구도 아닙니다. 첫 공개판에는 Authenticode 서명이 없어 Windows가 알 수 없는 게시자 경고를 표시할 수 있습니다. Tauri 분리 서명인 `.sig`는 Authenticode와 별개이며 Windows 게시자 평판을 형성하지 않습니다. Microsoft의 [SmartScreen 설명](https://feedback.smartscreen.microsoft.com/smartscreenfaq.aspx)과 [코드 서명 안내](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)를 참고하세요.

설치파일 실행 전에 다운로드한 두 파일의 SHA-256을 해당 버전 릴리스 노트의 **Checksums**와 비교하세요. PowerShell에서 `Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\path\downloaded-file.exe'`의 예시 경로를 실제 파일 경로로 바꿔 실행하고, `.sig` 파일도 같은 방법으로 확인합니다. 값의 일치는 게시된 파일과 바이트가 같다는 뜻이며, 안전성이나 게시자의 신원을 단독으로 인증하지 않습니다. 값이 다르거나 보안 프로그램이 악성코드를 탐지하면 실행을 중단하고 [정확한 경고를 제보](docs/SUPPORT.ko-KR.md)해 주세요.

[Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)이 없으면 먼저 직접 설치하세요. 현재 Windows 사용자에게 설치합니다.

1. 설치 전에 설정에서 **앱 종료**를 누르세요. 앱이 실행 중이어서 파일을 쓸 수 없다면 앱을 정상 종료한 뒤 같은 설치기의 **재시도**를 누르세요. 계속 실패하면 표시된 오류를 먼저 확인하세요. 파일 쓰기 실패에는 다른 원인도 있을 수 있습니다.
2. 설치가 성공하면 완료 화면에서 **닫기**를 누르세요. 같은 이름의 바로가기가 없으면 바탕화면 바로가기 생성 여부를 **예 / 아니오**로 선택할 수 있습니다. 기존 바로가기는 보존하며 앱은 자동 실행하지 않습니다.

설정 > 정보의 **프로그램 버전 관리**는 앱 시작 시와 정보 탭을 열 때 최신 버전을 확인합니다. **최신 버전 링크 열기**로 Releases 페이지를 열고 저장소와 버전을 확인한 뒤 설치파일을 받으세요. 앱을 종료한 뒤 기록된 폴더에 재설치하면 설정·프리셋·스킨이 유지됩니다. 제거해도 사용자 데이터는 보존합니다. 설치를 취소하거나 중단했다면 앱을 종료하고 같은 설치파일을 다시 실행해 프로그램 파일을 복구하세요. 설치파일 다운로드와 설치는 직접 진행하며, 자동 복구·WebView2 자동 설치는 제공하지 않습니다.

[다운로드](https://github.com/d-meloper/dmelopers-block-pet/releases/latest) · [English](README.md) · [지원](docs/SUPPORT.ko-KR.md) · [개인정보](docs/PRIVACY.ko-KR.md) · [보안](docs/SECURITY.ko-KR.md) · [기여](docs/CONTRIBUTING.ko-KR.md) · [제3자 고지](docs/THIRD_PARTY_NOTICES.ko-KR.md)

공식 Minecraft 제품이 아닙니다. Mojang 또는 Microsoft의 승인이나 제휴를 받지 않았습니다.
