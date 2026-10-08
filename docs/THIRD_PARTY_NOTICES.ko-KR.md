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


## 모델과 스킨

기본 복셀 인체 모델(`dmeloper.glb`), 기본 PNG 스킨(`default.png`), 앱 아이콘(`../app/public/logo.png` 및 생성된 파생 아이콘)은 DMeloper가 직접 제작했으며 프로젝트의 [MIT 라이선스](../LICENSE)를 적용합니다. 저작권·허가 고지를 유지하면 수정·재배포·상업적 이용이 가능합니다. GLB에는 캐릭터 스킨이 내장되어 있지 않고 별도 PNG가 기본 외형을 제공합니다.

사용자가 가져온 스킨은 배포본에 포함하지 않으며 프로젝트의 MIT 라이선스를 자동으로 적용받지 않습니다. 직접 제작한 앱 아이콘과 아래의 제3자 UI 아이콘·상표는 별개이며 후자는 각자의 권리 조건을 유지합니다.

Minecraft, Steve, Mojang, Microsoft는 각 권리자의 이름·상표입니다. 공식 Minecraft 제품이 아니며 Mojang 또는 Microsoft와 승인·제휴 관계가 없습니다. 호환성 설명은 게임 자산이나 사용자 스킨의 이용 권리를 부여하지 않습니다.

## UI 아이콘

[Solar Icons](https://icon-sets.iconify.design/solar/)는 [480 Design](https://www.figma.com/community/file/1166831539721848736)의 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 자산입니다. 앱은 원래 모양을 바꾸지 않고 표시 크기와 색상을 조정합니다.

[Lucide Icons](https://icon-sets.iconify.design/lucide/)는 Lucide Contributors의 ISC 라이선스와 Cole Bemis의 Feather 파생 아이콘에 적용되는 MIT 고지를 함께 따릅니다. 화살표와 사각형에는 Feather 파생 자산이 포함됩니다. 두 라이선스와 저작권 고지를 모두 유지합니다. Solar와 Lucide 아이콘은 로컬 패키지에서 CSS로 빌드하며 실행 중 CDN에서 받지 않습니다.

앱 정보의 채워진 GitHub 아이콘은 [Ant Design Icons](https://github.com/ant-design/ant-design-icons)의 로컬 `@ant-design/icons-vue` 패키지에서 가져오며 MIT 라이선스를 따릅니다. 원래 저작권과 라이선스 원문은 오프라인 고지에 포함합니다.
Notion 링크에는 운영자가 제공한 참고 이미지에 맞춰 만든 로컬 벡터를 사용합니다. Notion의 이름과 표시는 해당 권리자에게 속하며, 이 안내가 새로운 오픈소스 라이선스를 부여하거나 원저작자임을 주장하지 않습니다.

## 오프라인 고지와 소스

환경설정 창 > 정보 > 제3자 라이선스 안내에서 MIT 라이선스·출처와 의존성 고지를 오프라인으로 읽을 수 있습니다. 라이선스 고지는 `../app/src/legal/notices.txt`, CycloneDX 목록은 `../app/src/legal/dependencies.cdx.json`에 있습니다. 바로 아래의 데이터·권한 안내에서 앱의 데이터와 권한 사용을 현재 앱 언어로 별도로 확인할 수 있습니다. WiX 설치판은 네이티브 WiX SDK의 라이선스와 고지가 담긴 `ThirdParty-WiX.txt`도 설치 폴더에 제공합니다. 이 설치 프로그램 고지는 앱의 Node·Rust 목록과 별도입니다.

목록에는 앱의 Node·Windows Rust 구성요소와 Solar/Lucide 아이콘이 포함됩니다. 앱을 빌드할 때 사용하는 라이브러리도 함께 기재합니다. 자세한 구성요소별 사용 관계와 고정 버전은 기계 판독용 목록에 기록합니다. 빌드 의존성이 기재되어도 설치 실행 파일에 모두 연결되었다는 뜻은 아닙니다. 제공된 LICENSE/NOTICE 원문은 보존하며 별도 파일 없이 SPDX만 선언된 패키지는 저자 메타데이터·원본 헤더와 해당 표준 조건을 제공합니다. 없는 연도나 저작권자를 만들지 않습니다.

MPL-2.0 의존성은 오프라인 고지의 정확한 버전 소스 다운로드 주소로 제공되며 이 프로젝트가 수정하지 않았습니다. 각 의존성의 라이선스와 소스 제공 의무는 앱의 MIT 라이선스와 별개입니다. 자세한 원문은 [영문 고지](THIRD_PARTY_NOTICES.md)에서 함께 확인할 수 있습니다.
