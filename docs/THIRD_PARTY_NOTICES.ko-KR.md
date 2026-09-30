# 제3자 고지

한국어 · [English](THIRD_PARTY_NOTICES.md)

## 원본 코드

앱 일부는 MIT 라이선스의 [ayangweb/BongoCat v1.1.0](https://github.com/ayangweb/BongoCat/tree/v1.1.0)에서 파생되었습니다.

- 주석 태그 객체: `2a4e3b51706fe9e1ed5f8e39aed02336583a8823`
- 원본 커밋: `84f9f4ccfb11d8a4aefb9623934637878be0e384`
- 원본 저작권: `Copyright (c) 2025 ayangweb`

원본 저작권과 MIT 허가 고지는 [LICENSE](../LICENSE)에 보존했습니다.

DMeloper's Block Pet은 독립적으로 수정·관리되는 파생작이며 공식 BongoCat 릴리즈 또는 원 프로젝트의 승인 제품이 아닙니다. 원본 코드 라이선스는 별도의 캐릭터·이름·브랜드·사용자 스킨·모델·음악·상표 권리를 부여하지 않습니다. Bongo Cat 캐릭터 모델이나 원본 Live2D 모델은 포함하지 않습니다.

## 포함된 소스

`../app/vendor/tauri-winres`는 tauri-winres 0.3.5의 로컬 패치입니다. 원래 MIT 라이선스와 Tauri Apps Contributors·Max Resch의 저작권 고지를 보존합니다.

이전 구현의 소스로 보존한 설치 보조 도구 `block_pet_installer_utils.dll`은 [Tauri nsis-tauri-utils 0.5.3](https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3)에서 파생되었습니다. `../app/src-tauri/windows/installer-utils`에 소스, 원래 MIT·Apache-2.0 조건, `Copyright (c) 2019 - 2022 Tauri Programme within The Commons Conservancy` 고지와 고정한 원본 아카이브·소스 해시를 보존합니다. 로컬 파생판은 버전 비교·프로세스 조회·비상승 권한 실행만 남기고 사용하지 않는 강제 종료·문자열 명령을 제거했습니다. 포함된 `nsis-plugin-api`와 `nsis-fn` 원본 소스는 변경하지 않았습니다. 이 DLL은 공식 Tauri 배포 파일이나 Authenticode 서명 파일이 아닙니다. 현재 GitHub·Store 패키지는 이 도구를 빌드하거나 포함하지 않으며 소스와 고지는 이전 구현의 출처를 보존합니다.

공유 업데이트 코어와 이전 구현의 업데이트 작업 프로그램은 `../app/crates/update-core`에서 프로젝트 MIT 라이선스로 관리합니다. 현재 패키지는 별도의 업데이트 작업 프로그램을 배포하지 않습니다. 오프라인 고지는 이 프로그램과 과거 설치 플러그인을 별도 소스·빌드 사용 범위로 계속 기록하지만, 목록에 있다는 사실이 현재 배포를 뜻하지 않습니다.

`../app/vendor/tauri-plugin-updater`에는 GitHub판이 사용하는 Tauri updater 2.11.0의 로컬 패치가 있습니다. 해당 폴더와 오프라인 고지에 MIT·Apache-2.0 원문, 원본 식별정보와 로컬 변경 내용을 보존합니다. Store판은 이 업데이트 구성요소를 사용하지 않습니다.

## 모델과 스킨

복셀 인체 모델과 기본 PNG 스킨은 DMeloper가 제작하고 공개 소스와 설치판에 포함하도록 승인했습니다. GLB에는 캐릭터 스킨이 내장되어 있지 않습니다. 앱 아이콘은 운영자가 제공하고 앱 사용을 승인했으며 추가적인 원저작자 주장을 하지 않습니다. 사용자가 가져온 스킨은 배포본에 포함하지 않습니다.

Minecraft, Steve, Mojang, Microsoft는 각 권리자의 이름·상표입니다. 공식 Minecraft 제품이 아니며 Mojang 또는 Microsoft와 승인·제휴 관계가 없습니다. 호환성 설명은 게임 자산이나 사용자 스킨의 이용 권리를 부여하지 않습니다.

## UI 아이콘

[Solar Icons](https://icon-sets.iconify.design/solar/)는 [480 Design](https://www.figma.com/community/file/1166831539721848736)의 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 자산입니다. 앱은 원래 모양을 바꾸지 않고 표시 크기와 색상을 조정합니다.

[Lucide Icons](https://icon-sets.iconify.design/lucide/)는 Lucide Contributors의 ISC 라이선스와 Cole Bemis의 Feather 파생 아이콘에 적용되는 MIT 고지를 함께 따릅니다. 화살표와 사각형에는 Feather 파생 자산이 포함됩니다. 두 라이선스와 저작권 고지를 모두 유지합니다. 아이콘은 로컬 패키지에서 CSS로 빌드하며 실행 중 CDN에서 받지 않습니다.

## 오프라인 고지와 소스

설정 > 앱 정보 > 제3자 라이선스 안내에서 MIT 라이선스·출처와 의존성 고지를 오프라인으로 읽을 수 있습니다. 라이선스 고지는 `../app/src/legal/notices.txt`, CycloneDX 목록은 `../app/src/legal/dependencies.cdx.json`에 있습니다. 바로 아래의 데이터·권한 안내에서 앱의 데이터와 권한 사용을 현재 앱 언어로 별도로 확인할 수 있습니다.

목록에는 앱의 Node·Windows Rust 구성요소, Solar/Lucide 아이콘과 보존된 소스의 구성요소가 포함됩니다. 앱을 빌드할 때 사용하는 라이브러리도 함께 기재합니다. 자세한 구성요소별 사용 관계와 고정 버전은 기계 판독용 목록에 기록하며, 과거 업데이트 작업 프로그램과 설치 보조 도구는 현재 패키지에 포함하지 않습니다. 빌드 의존성이 기재되어도 설치 실행 파일에 모두 연결되었다는 뜻은 아닙니다. 제공된 LICENSE/NOTICE 원문은 보존하며 별도 파일 없이 SPDX만 선언된 패키지는 저자 메타데이터·원본 헤더와 해당 표준 조건을 제공합니다. 없는 연도나 저작권자를 만들지 않습니다.

MPL-2.0 의존성은 오프라인 고지의 정확한 버전 소스 다운로드 주소로 제공되며 이 프로젝트가 수정하지 않았습니다. 각 의존성의 라이선스와 소스 제공 의무는 앱의 MIT 라이선스와 별개입니다. 자세한 원문은 [영문 고지](THIRD_PARTY_NOTICES.md)에서 함께 확인할 수 있습니다.
