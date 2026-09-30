; GitHub installer: explicit Tauri update, manual repair and preserved shared data.
; Uses the pinned official NSIS System plugin for the installation mutex.
Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma
SetDatablockOptimize on
AllowSkipFiles off
!include LogicLib.nsh
!include FileFunc.nsh
!include WordFunc.nsh
!include x64.nsh
!include MUI2.nsh
!include nsDialogs.nsh
!define PRODUCTNAME "DMeloper's Block Pet"
!define MAIN "{{main_binary_name}}.exe"
!define VERSION "{{version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define WEBVIEWKEY "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define MINWEBVIEW "{{minimum_webview2_version}}"
Var InstallerMutex
Var InstallMarker
Var UpdateMode
Var RestartAfterUpdate
Var UpdateWait
Var UpdateHandle
Var RecordedLocation
Var ShortcutPath
Var ShortcutOriginal
Var DesktopReceiptTemp
Var DesktopShortcutResult
Var RunAfterInstall
Var DeleteUserData
Var DeleteUserDataCheckbox
Name "${PRODUCTNAME}"
BrandingText "DMeloper"
OutFile "{{out_file}}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "{{version_with_build}}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME} GitHub installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "DMeloper"
VIAddVersionKey "LegalCopyright" "DMeloper"
!if "{{installer_icon}}" != ""
!define MUI_ICON "{{installer_icon}}"
!define MUI_UNICON "{{installer_icon}}"
Icon "{{installer_icon}}"
UninstallIcon "{{installer_icon}}"
!endif
!define MUI_WELCOMEPAGE_TITLE "$(WelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(WelcomeText)"
!define MUI_DIRECTORYPAGE_TEXT_TOP "$(InstallHint)"
!define MUI_COMPONENTSPAGE_TEXT_TOP "$(OptionsIntro)"
!define MUI_FINISHPAGE_TITLE "$(FinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(FinishText)"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${MAIN}"
!define MUI_FINISHPAGE_RUN_TEXT "$(RunAfterInstallOption)"
!define MUI_FINISHPAGE_RUN_FUNCTION MarkRunAfterInstall
!define MUI_UNCONFIRMPAGE_TEXT_TOP "$(UninstallConfirmText)"
LangString WelcomeTitle 1033 "Welcome to ${PRODUCTNAME}"
LangString WelcomeTitle 1042 "${PRODUCTNAME} 설치"
LangString WelcomeText 1033 "This wizard installs ${PRODUCTNAME} for your Windows account. Choose shortcut options on the next page."
LangString WelcomeText 1042 "이 마법사는 현재 Windows 계정에 ${PRODUCTNAME}을(를) 설치합니다. 다음 화면에서 바로가기 생성 여부를 선택하세요."
LangString OptionsIntro 1033 "Choose whether to create desktop and Start menu shortcuts."
LangString OptionsIntro 1042 "바탕화면과 시작 메뉴 바로가기를 만들지 선택하세요."
LangString DesktopShortcutOption 1033 "Create a desktop shortcut"
LangString DesktopShortcutOption 1042 "바탕화면 바로가기 만들기"
LangString StartMenuShortcutOption 1033 "Create a Start menu shortcut"
LangString StartMenuShortcutOption 1042 "시작 메뉴 바로가기 만들기"
LangString RunAfterInstallOption 1033 "Run the app after installation"
LangString RunAfterInstallOption 1042 "설치 후 앱 실행"
LangString DesktopShortcutDescription 1033 "Create a desktop shortcut if one does not already exist."
LangString DesktopShortcutDescription 1042 "같은 이름의 바로가기가 없으면 바탕화면에 바로가기를 만듭니다."
LangString StartMenuShortcutDescription 1033 "Create a Start menu shortcut if one does not already exist."
LangString StartMenuShortcutDescription 1042 "같은 이름의 바로가기가 없으면 시작 메뉴에 바로가기를 만듭니다."
LangString FinishTitle 1033 "Installation complete"
LangString FinishTitle 1042 "설치 완료"
LangString FinishText 1033 "${PRODUCTNAME} has been installed. Choose whether to run the app, then select Finish to close this wizard."
LangString FinishText 1042 "${PRODUCTNAME} 설치를 마쳤습니다. 앱 실행 여부를 선택한 뒤 마침을 눌러 설치 프로그램을 닫으세요."
LangString UninstallConfirmText 1033 "The app files will be removed. User data is kept unless you select the separate removal option."
LangString UninstallConfirmText 1042 "앱 파일을 제거합니다. 별도 데이터 삭제 옵션을 선택하지 않으면 사용자 데이터는 유지됩니다."
LangString UninstallDataTitle 1033 "User data"
LangString UninstallDataTitle 1042 "사용자 데이터"
LangString UninstallDataSubtitle 1033 "Choose whether to keep or remove your personal settings and files."
LangString UninstallDataSubtitle 1042 "개인 설정과 파일을 유지할지 삭제할지 선택하세요."
LangString UninstallDataDescription 1033 "By default, settings, presets and skins are kept after uninstalling."
LangString UninstallDataDescription 1042 "기본 제거에서는 설정·프리셋·스킨을 유지합니다."
LangString DeleteUserDataOption 1033 "Remove all personal settings and files"
LangString DeleteUserDataOption 1042 "모든 개인 설정 및 파일 제거"
LangString DeleteUserDataSharedWarning 1033 "Removes all user data, including settings, presets and skins."
LangString DeleteUserDataSharedWarning 1042 "설정·프리셋·스킨 등 사용자 데이터를 모두 제거합니다."
LangString DeleteUserDataRunning 1033 "The program is running. Close it and try uninstalling again. No data was deleted."
LangString DeleteUserDataRunning 1042 "프로그램이 실행 중입니다. 종료 후 다시 제거를 시도해주세요. 데이터는 삭제되지 않았습니다."
LangString DeleteUserDataFailure 1033 "The selected data could not be safely removed. Some files may already have been deleted; the app itself has not been uninstalled."
LangString DeleteUserDataFailure 1042 "선택한 데이터를 안전하게 삭제하지 못했습니다. 일부 파일은 이미 삭제되었을 수 있으며 앱 자체는 제거하지 않았습니다."
LangString DeleteUserDataRequestFailure 1033 "The data removal request could not be verified. Run the uninstaller again and retry."
LangString DeleteUserDataRequestFailure 1042 "데이터 삭제 요청을 확인할 수 없습니다. 제거 프로그램을 다시 실행해 재시도하세요."
LangString DeleteUserDataLaunchFailure 1033 "The data cleanup could not start. The app itself has not been uninstalled."
LangString DeleteUserDataLaunchFailure 1042 "데이터 정리를 시작하지 못했습니다. 앱 자체는 제거하지 않았습니다."
LangString InstallHint 1033 "Close the app before installing. Reinstall to the same folder to keep settings, presets and skins. Updates can also be installed from the app. Repair after an interrupted installation is manual."
LangString InstallHint 1042 "설치 전에 앱을 종료하세요. 같은 폴더에 재설치하면 설정·프리셋·스킨을 유지합니다. 앱에서 업데이트를 설치할 수 있습니다. 설치 중단 후 복구는 수동으로 진행합니다."
LangString RuntimeMissing 1033 "Microsoft WebView2 Runtime is required. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and run this installer again. No app files were installed."
LangString RuntimeMissing 1042 "Microsoft WebView2 Runtime이 필요합니다. https://developer.microsoft.com/microsoft-edge/webview2/ 에서 직접 설치한 뒤 다시 실행하세요. 앱 파일은 설치하지 않았습니다."
LangString WindowsUnsupported 1033 "Windows 11 24H2 (build 26100) or later, x64, is required."
LangString WindowsUnsupported 1042 "Windows 11 24H2(빌드 26100) 이상 x64 환경이 필요합니다."
LangString FileFailure 1033 "A file could not be written or removed. Close the app and try again. If installation was interrupted, run the installer again in the same folder."
LangString FileFailure 1042 "파일을 쓰거나 제거하지 못했습니다. 앱을 종료한 뒤 다시 시도하세요. 설치가 중단됐다면 같은 폴더에 다시 설치하세요."
LangString FileRetry 1033 "This file could not be written:$\r$\n$0$\r$\n$\r$\nThe app may still be running, or the folder may not be writable. Close the app using Quit App in Settings, then click Retry here. If the app is already closed, check access to this folder. Click Cancel to stop installation."
LangString FileRetry 1042 "다음 파일을 쓸 수 없습니다:$\r$\n$0$\r$\n$\r$\n앱이 실행 중이거나 폴더에 쓰기 권한이 없을 수 있습니다. 설정의 '앱 종료'로 앱을 종료한 뒤 여기서 '재시도'를 누르세요. 이미 종료했다면 폴더 접근 권한을 확인하세요. 설치를 중단하려면 '취소'를 누르세요."
LangString DesktopCreated 1033 "Desktop shortcut created."
LangString DesktopCreated 1042 "바탕화면 바로가기를 만들었습니다."
LangString DesktopCreateFailure 1033 "Installation is complete, but the desktop shortcut could not be created. You can open the app from the installation folder:$\r$\n$INSTDIR"
LangString DesktopCreateFailure 1042 "설치는 완료됐지만 바탕화면 바로가기를 만들지 못했습니다. 다음 설치 폴더에서 앱을 실행할 수 있습니다:$\r$\n$INSTDIR"
LangString DesktopReceiptFailure 1033 "Installation is complete and the desktop shortcut was created, but its removal record could not be saved. You may need to remove this shortcut manually when uninstalling."
LangString DesktopReceiptFailure 1042 "설치와 바탕화면 바로가기 생성은 완료됐지만 제거용 기록을 저장하지 못했습니다. 앱을 제거할 때 이 바로가기는 직접 삭제해야 할 수 있습니다."
FileErrorText "$(FileRetry)" "$(FileRetry)"
DirText "$(InstallHint)"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUpdatePage
!insertmacro MUI_PAGE_WELCOME
!if "{{license}}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUpdatePage
  !insertmacro MUI_PAGE_LICENSE "{{license}}"
!endif
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUpdatePage
!insertmacro MUI_PAGE_DIRECTORY
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUpdatePage
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUpdatePage
!insertmacro MUI_PAGE_FINISH
UninstPage custom un.UserDataOptionsPage un.UserDataOptionsLeave
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

Function .onInit
  Call SelectInstallerLanguage
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    SetErrorLevel 1633
    Abort
  ${EndIf}
  ${GetParameters} $0
  StrCpy $UpdateMode 0
  StrCpy $RestartAfterUpdate 0
  StrCpy $RunAfterInstall 0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  IfErrors manual_init
  StrCpy $UpdateMode 1
  SetAutoClose true
  ; /D is supplied from the verified running application's exact parent.
  ReadRegStr $RecordedLocation HKCU "${UNINSTKEY}" "InstallLocation"
  StrCmp $RecordedLocation "" invalid_update
  StrCmp $RecordedLocation $INSTDIR 0 invalid_update
  IfFileExists "$INSTDIR\${MAIN}" 0 invalid_update
  ClearErrors
  ${GetOptions} $0 "/R" $1
  IfErrors manual_init
  StrCpy $RestartAfterUpdate 1
  Goto manual_init
invalid_update:
  MessageBox MB_OK|MB_ICONSTOP "$(FileFailure)" /SD IDOK
  SetErrorLevel 87
  Abort
manual_init:
  Call InitializeInstallOptions
  ClearErrors
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  IntCmp $1 26100 windows_ok windows_bad windows_ok
windows_bad:
  MessageBox MB_OK|MB_ICONSTOP "$(WindowsUnsupported)" /SD IDOK
  SetErrorLevel 1633
  Abort
windows_ok:
  Call RequireWebView
FunctionEnd

Function SkipUpdatePage
  StrCmp $UpdateMode 1 0 skip_update_done
  Abort
skip_update_done:
FunctionEnd

Function SelectInstallerLanguage
  System::Call 'kernel32::GetUserDefaultUILanguage() i.r0'
  IntOp $0 $0 & 1023
  StrCmp $0 18 0 select_english
  StrCpy $LANGUAGE 1042
  Return
select_english:
  StrCpy $LANGUAGE 1033
FunctionEnd

; Wait for the original process to release its image; never kill it or another
; user's app. This runs before any payload write. A timeout changes no app file.
Function WaitForUpdateExit
  StrCmp $UpdateMode 1 0 wait_update_done
  StrCpy $UpdateWait 0
wait_update_retry:
  ClearErrors
  FileOpen $UpdateHandle "$INSTDIR\${MAIN}" a
  IfErrors wait_update_busy
  FileClose $UpdateHandle
  Goto wait_update_done
wait_update_busy:
  IntOp $UpdateWait $UpdateWait + 1
  IntCmp $UpdateWait 150 wait_update_failed wait_update_sleep wait_update_failed
wait_update_sleep:
  Sleep 100
  Goto wait_update_retry
wait_update_failed:
  MessageBox MB_OK|MB_ICONSTOP "$(FileFailure)" /SD IDOK
  SetErrorLevel 32
  Abort
wait_update_done:
  ClearErrors
FunctionEnd

Function RequireWebView
retry_webview:
  ; Official registration views only. Never download or execute a runtime.
  ; A stale machine registration must not hide a compatible per-user runtime.
  SetRegView 32
  ReadRegStr $4 HKLM "${WEBVIEWKEY}" "pv"
  Call RuntimeVersionSupported
  StrCmp $0 1 runtime_ready
  ReadRegStr $4 HKCU "${WEBVIEWKEY}" "pv"
  Call RuntimeVersionSupported
  StrCmp $0 1 runtime_ready
  SetRegView 64
  ReadRegStr $4 HKLM "${WEBVIEWKEY}" "pv"
  Call RuntimeVersionSupported
  StrCmp $0 1 runtime_ready
  ReadRegStr $4 HKCU "${WEBVIEWKEY}" "pv"
  Call RuntimeVersionSupported
  StrCmp $0 1 runtime_ready
  SetRegView 64
  IfSilent runtime_abort
  ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/"
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(RuntimeMissing)" /SD IDCANCEL IDRETRY retry_webview
runtime_abort:
  SetErrorLevel 1603
  Abort
runtime_ready:
  SetRegView 64
  Return
FunctionEnd

Function RuntimeVersionSupported
  StrCmp $4 "" version_unsupported
  ${VersionCompare} "$4" "1.0.0.0" $0
  StrCmp $0 2 version_unsupported
  !if "${MINWEBVIEW}" != ""
    ${VersionCompare} "$4" "${MINWEBVIEW}" $0
    StrCmp $0 2 version_unsupported
  !endif
  StrCpy $0 1
  Return
version_unsupported:
  StrCpy $0 0
FunctionEnd

!macro CheckWrite
  IfErrors 0 +4
    MessageBox MB_OK|MB_ICONSTOP "$(FileFailure)" /SD IDOK
    SetErrorLevel 1
    Abort
!macroend

!macro InstallationMutex PREFIX
Function ${PREFIX}AcquireInstallerMutex
installer_retry:
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\DMeloper.BlockPet.Installer") p .r0 ?e'
  Pop $1
  StrCpy $InstallerMutex $0
  StrCmp $0 0 installer_failed
  StrCmp $1 183 installer_busy installer_ready
installer_busy:
  System::Call 'kernel32::CloseHandle(p $InstallerMutex)'
  StrCpy $InstallerMutex 0
  IfSilent installer_failed
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(FileFailure)" /SD IDCANCEL IDRETRY installer_retry
installer_failed:
  SetErrorLevel 1618
  Abort
installer_ready:
FunctionEnd
!macroend
!insertmacro InstallationMutex ""
!insertmacro InstallationMutex "un."

Section "-Core application files" SecInstall
  Call RequireWebView
  Call WaitForUpdateExit
  Call AcquireInstallerMutex
  ClearErrors
  SetOutPath "$INSTDIR"
  !insertmacro CheckWrite
  ClearErrors
  FileOpen $InstallMarker "$INSTDIR\.block-pet-installing" w
  !insertmacro CheckWrite
  FileWrite $InstallMarker "Interrupted installation: repair with the same installer."
  !insertmacro CheckWrite
  System::Call 'kernel32::FlushFileBuffers(p $InstallMarker) i .r0'
  StrCmp $0 0 0 +2
    SetErrors
  !insertmacro CheckWrite
  FileClose $InstallMarker
  !insertmacro CheckWrite
  ; An in-use main blocks before replacing resources; there is no forced exit.
  ClearErrors
  SetOverwrite on
  File "{{main_binary_path}}"
  !insertmacro CheckWrite
  {{#each resources_dirs}}
    ClearErrors
    CreateDirectory "$INSTDIR\\{{this}}"
    !insertmacro CheckWrite
  {{/each}}
  {{#each resources}}
    ClearErrors
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
    !insertmacro CheckWrite
  {{/each}}
  {{#each binaries}}
    !error "GitHub NSIS must not contain an external executable"
  {{/each}}
  ClearErrors
  WriteUninstaller "$INSTDIR\uninstall.exe"
  !insertmacro CheckWrite
  ClearErrors
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "DMeloper"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAIN}$\""
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "${UNINSTKEY}" "DeliveryMode" "tauri-github-nsis-v1"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  !insertmacro CheckWrite
  SetErrorLevel 0
SectionEnd

Section /o "$(DesktopShortcutOption)" SecDesktopShortcut
  StrCmp $UpdateMode 1 desktop_option_done
  Call CreateDesktopShortcut
desktop_option_done:
SectionEnd

Section /o "$(StartMenuShortcutOption)" SecStartMenuShortcut
  ; Preserve an existing user shortcut; receipt only links created here.
  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" startmenu_option_done
  ClearErrors
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAIN}"
  !insertmacro CheckWrite
  CopyFiles /SILENT "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\start-menu-original.lnk"
  !insertmacro CheckWrite
startmenu_option_done:
SectionEnd

Function InitializeInstallOptions
  ; Silent installs retain the old behavior: no desktop link, Start menu link,
  ; and launch the app. Updates keep the missing Start menu link repair.
  SectionSetFlags ${SecStartMenuShortcut} 1
  SectionSetFlags ${SecDesktopShortcut} 0
  StrCmp $UpdateMode 1 install_options_done
  IfSilent install_options_silent
  SectionSetFlags ${SecDesktopShortcut} 1
  Goto install_options_done
install_options_silent:
  StrCpy $RunAfterInstall 1
install_options_done:
FunctionEnd

Function MarkRunAfterInstall
  StrCpy $RunAfterInstall 1
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktopShortcut} "$(DesktopShortcutDescription)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenuShortcut} "$(StartMenuShortcutDescription)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; Manual success follows the selected launch option. Update success retains /R.
Function .onInstSuccess
  ClearErrors
  Delete "$INSTDIR\.block-pet-installing"
  !insertmacro CheckWrite
  System::Call 'kernel32::CloseHandle(p $InstallerMutex)'
  StrCpy $InstallerMutex 0
  StrCmp $UpdateMode 1 0 manual_success
  StrCmp $RestartAfterUpdate 1 launch_installed_app install_done
manual_success:
  StrCmp $RunAfterInstall 1 launch_installed_app install_done
launch_installed_app:
  ; No network/caller arguments are forwarded to the new app.
  SetOutPath "$INSTDIR"
  Exec '$\"$INSTDIR\${MAIN}$\"'
install_done:
  SetErrorLevel 0
FunctionEnd

Function CreateDesktopShortcut
  StrCpy $DesktopShortcutResult "preserved"
  StrCpy $DesktopReceiptTemp ""
  ; Recheck after the question: another installer/user may have added a link.
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" desktop_return

  ; Save at the final Shell Link path so the Shell receives its creation event.
  ; Renaming a staged .tmp link leaves the Shell notified of only the temp path.
  ClearErrors
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAIN}"
  IfErrors desktop_create_failed

  ; Keep a verified byte receipt for conservative removal of this new link.
  ClearErrors
  GetTempFileName $DesktopReceiptTemp "$INSTDIR"
  IfErrors desktop_receipt_failed
  CopyFiles /SILENT "$DESKTOP\${PRODUCTNAME}.lnk" "$DesktopReceiptTemp"
  IfErrors desktop_receipt_failed
  StrCpy $ShortcutPath "$DESKTOP\${PRODUCTNAME}.lnk"
  StrCpy $ShortcutOriginal $DesktopReceiptTemp
  Call ShortcutOwned
  StrCmp $9 1 0 desktop_receipt_failed

  ; Replace the old receipt only after this installation created a new link.
  ClearErrors
  Delete "$INSTDIR\desktop-original.lnk"
  IfErrors desktop_receipt_failed
  Rename "$DesktopReceiptTemp" "$INSTDIR\desktop-original.lnk"
  IfErrors desktop_receipt_failed
  StrCpy $DesktopReceiptTemp ""
  StrCpy $DesktopShortcutResult "created"
  DetailPrint "$(DesktopCreated)"
  Goto desktop_cleanup

desktop_create_failed:
  StrCpy $DesktopShortcutResult "create-failed"
  DetailPrint "$(DesktopCreateFailure)"
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(DesktopCreateFailure)" /SD IDOK
  Goto desktop_cleanup
desktop_receipt_failed:
  StrCpy $DesktopShortcutResult "receipt-failed"
  DetailPrint "$(DesktopReceiptFailure)"
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(DesktopReceiptFailure)" /SD IDOK
desktop_cleanup:
  StrCmp $DesktopReceiptTemp "" +2
    Delete "$DesktopReceiptTemp"
desktop_return:
  ClearErrors
  SetErrorLevel 0
FunctionEnd

Function un.onInit
  Call un.SelectInstallerLanguage
  SetShellVarContext current
  SetRegView 64
  StrCpy $DeleteUserData 0
FunctionEnd

Function un.SelectInstallerLanguage
  System::Call 'kernel32::GetUserDefaultUILanguage() i.r0'
  IntOp $0 $0 & 1023
  StrCmp $0 18 0 un_select_english
  StrCpy $LANGUAGE 1042
  Return
un_select_english:
  StrCpy $LANGUAGE 1033
FunctionEnd

Function un.UserDataOptionsPage
  !insertmacro MUI_HEADER_TEXT "$(UninstallDataTitle)" "$(UninstallDataSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  ${NSD_CreateLabel} 0 0 100% 32u "$(UninstallDataDescription)"
  Pop $0
  ${NSD_CreateCheckBox} 0 42u 100% 16u "$(DeleteUserDataOption)"
  Pop $DeleteUserDataCheckbox
  ${NSD_Uncheck} $DeleteUserDataCheckbox
  ${NSD_CreateLabel} 0 68u 100% 56u "$(DeleteUserDataSharedWarning)"
  Pop $0
  ${NSD_SetFocus} $DeleteUserDataCheckbox
  nsDialogs::Show
FunctionEnd

Function un.UserDataOptionsLeave
  ${NSD_GetState} $DeleteUserDataCheckbox $DeleteUserData
FunctionEnd

; Unknown or modified shortcut targets are preserved without loading a DLL.
; Inputs are paths to the link and the original byte receipt; $9 is the result.
!macro ShortcutOwned PREFIX
Function ${PREFIX}ShortcutOwned
  StrCpy $9 0
  ClearErrors
  FileOpen $0 "$ShortcutOriginal" r
  IfErrors shortcut_return
  FileOpen $1 "$ShortcutPath" r
  IfErrors shortcut_close_first
  FileSeek $0 0 END $2
  FileSeek $1 0 END $3
  StrCmp $2 $3 0 shortcut_close_both
  IntCmp $2 1048576 shortcut_close_both 0 shortcut_close_both
  IntCmp $2 0 shortcut_close_both shortcut_close_both 0
  FileSeek $0 0 SET
  FileSeek $1 0 SET
  StrCpy $4 0
shortcut_loop:
  ClearErrors
  FileReadByte $0 $5
  FileReadByte $1 $6
  IfErrors shortcut_close_both
  StrCmp $5 $6 0 shortcut_close_both
  IntOp $4 $4 + 1
  IntCmp $4 $2 shortcut_equal shortcut_loop shortcut_close_both
shortcut_equal:
  StrCpy $9 1
shortcut_close_both:
  FileClose $1
shortcut_close_first:
  FileClose $0
shortcut_return:
FunctionEnd
!macroend
!insertmacro ShortcutOwned ""
!insertmacro ShortcutOwned "un."

Section Uninstall
  Call un.AcquireInstallerMutex
  StrCmp $DeleteUserData 1 un_delete_user_data un_user_data_kept
un_delete_user_data:
  ClearErrors
  ExecWait '$\"$INSTDIR\${MAIN}$\" --dmeloper-uninstall-delete-user-data' $0
  IfErrors un_user_data_launch_failed
  ${If} $0 == 0
    Goto un_user_data_kept
  ${ElseIf} $0 == 20
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(DeleteUserDataRunning)" /SD IDOK
  ${ElseIf} $0 == 22
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(DeleteUserDataRequestFailure)" /SD IDOK
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(DeleteUserDataFailure)" /SD IDOK
  ${EndIf}
  SetErrorLevel 1
  Abort
un_user_data_launch_failed:
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(DeleteUserDataLaunchFailure)" /SD IDOK
  SetErrorLevel 1
  Abort
un_user_data_kept:
  ; Exact files only. Never recursively delete directories or user profiles.
  ClearErrors
  Delete "$INSTDIR\${MAIN}"
  !insertmacro CheckWrite
  {{#each resources}}
    ClearErrors
    Delete "$INSTDIR\\{{this.[1]}}"
    !insertmacro CheckWrite
  {{/each}}
  ; The manual payload inventory is fixed. Remove empty children before parents.
  RMDir "$INSTDIR\assets\models\dmeloper"
  RMDir "$INSTDIR\assets\models"
  RMDir "$INSTDIR\assets"
  StrCpy $ShortcutPath "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  StrCpy $ShortcutOriginal "$INSTDIR\start-menu-original.lnk"
  Call un.ShortcutOwned
  StrCmp $9 1 0 +2
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  Delete "$INSTDIR\start-menu-original.lnk"
  StrCpy $ShortcutPath "$DESKTOP\${PRODUCTNAME}.lnk"
  StrCpy $ShortcutOriginal "$INSTDIR\desktop-original.lnk"
  Call un.ShortcutOwned
  StrCmp $9 1 0 +2
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$INSTDIR\desktop-original.lnk"
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  StrCmp $0 '$\"$INSTDIR\${MAIN}$\"' remove_autostart
  StrCmp $0 '$\"$INSTDIR\${MAIN}$\" ' remove_autostart autostart_done
remove_autostart:
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
autostart_done:
  ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
  StrCmp $0 $INSTDIR 0 +2
    DeleteRegKey HKCU "${UNINSTKEY}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  SetErrorLevel 0
SectionEnd

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Korean"
