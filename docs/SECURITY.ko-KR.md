# 보안 안내

한국어 · [English](SECURITY.md)

## 취약점 제보

[GitHub 비공개 보안 제보](https://github.com/d-meloper/dmelopers-block-pet/security/advisories/new)를 이용해 주세요. 영향을 받는 버전, 배포판, 발생할 수 있는 문제와 재현 방법을 함께 적어 주세요.

첨부 자료의 개인정보는 먼저 지워 주세요. 인증 정보나 공격에 필요한 세부 내용은 공개 이슈에 올리지 마세요.

보안 수정은 Windows 11 24H2 이상 x64의 최신 정식 공개 버전을 대상으로 합니다. GitHub판과 Store판의 제품 버전은 `X.Y.Z`로 같으며, Store 패키지 버전은 `X.Y.Z.0`입니다.

## 다운로드와 서명

GitHub판은 공식 저장소의 서명된 업데이트 정보를 확인합니다. 설치 전에 설치파일의 크기·SHA-256·Tauri 분리 서명을 검증합니다.

초기 GitHub 설치파일에는 Authenticode 서명이 없어 Windows에 알 수 없는 게시자가 표시될 수 있습니다. 함께 제공하는 Tauri `.sig` 서명은 Authenticode와 별개이며 Windows의 게시자 평판을 형성하지 않습니다.

Edge의 “일반적으로 다운로드되지 않습니다”는 평판에 관한 경고입니다. 이 문구만으로 파일이 악성코드이거나 안전하다고 판단할 수는 없습니다. 보안 프로그램이 악성코드를 탐지하면 실행을 중단하고 정확한 경고 내용을 알려 주세요.

Store 패키지의 서명과 업데이트는 Microsoft가 관리합니다. Microsoft가 서명한 설치 패키지는 제출 파일과 해시가 다를 수 있습니다.

## 다운로드한 파일 확인

릴리즈의 Checksums에는 파일별 SHA-256이 표시되어 있습니다. 설치파일을 실행하기 전에 PowerShell에서 `Get-FileHash -Algorithm SHA256 -LiteralPath '<다운로드한 파일>'`을 실행해 받은 파일마다 값을 비교하세요.

해시가 같으면 파일 내용이 일치한다는 뜻입니다. 해시만으로 안전성이나 게시자 신원을 확인할 수는 없습니다. 값이 다르면 파일을 실행하지 말고 제보해 주세요.

자세한 내용은 Microsoft의 [SmartScreen 안내](https://feedback.smartscreen.microsoft.com/smartscreenfaq.aspx)와 [코드 서명 안내](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)를 참고하세요.

## 설치 중 문제가 생겼을 때

설치가 실패해도 Saved Games의 공유 데이터는 유지됩니다. GitHub판 설치가 중단되었다면 같은 설치파일을 다시 실행해 프로그램 파일을 복구하세요. 자동 롤백은 제공하지 않습니다.

로그를 공유하기 전에는 개인정보를 확인하세요. 설치 도움말은 [지원 안내](SUPPORT.ko-KR.md)를 확인하세요.
