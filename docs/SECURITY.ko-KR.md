# 보안 정책

취약점은 [GitHub 비공개 보안 제보](https://github.com/d-meloper/dmelopers-block-pet/security/advisories/new)로 알려 주세요. 영향 버전·배포 경로·영향·재현 절차·개인정보를 제거한 근거를 포함하세요. 비밀 정보와 공격 세부 내용은 공개 이슈에 올리지 마세요.

보안 수정은 Windows 11 24H2 이상 x64의 최신 공개 stable 버전을 대상으로 합니다. GitHub와 Store는 같은 제품 버전 X.Y.Z를 쓰며 Store 패키지 버전은 X.Y.Z.0입니다.

GitHub판은 고정 공식 저장소의 서명된 정보를 확인하고 설치파일의 크기·SHA-256·Tauri 분리 서명을 검증한 뒤 사용자가 시작한 설치를 진행합니다. Tauri 서명과 Authenticode는 별개입니다. 초기 GitHub 설치파일에는 Authenticode 서명이 없어 Windows에 알 수 없는 게시자가 표시될 수 있습니다. 체크섬은 바이트 변경을 확인하며 게시자 신원을 단독으로 인증하지 않습니다. Store 서명·업데이트는 Microsoft가 관리하며 설치된 Microsoft 서명 패키지는 제출 파일 해시와 다를 수 있습니다.

설치 실패 시 공유 Saved Games 데이터를 보존합니다. GitHub 설치 중단은 같은 설치파일로 복구하며 자동 롤백을 제공하지 않습니다. 공유 전 로그의 개인정보를 확인하세요. 이 독립 개인 프로젝트는 SignPath 서명이나 CI에서 만든 공식 배포 바이너리를 주장하지 않습니다.
