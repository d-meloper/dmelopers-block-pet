; Test installer: explicit Tauri update, manual repair and preserved shared data.
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
!define PRODUCTNAME "DMeloper's Block Pet Test"
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
Name "${PRODUCTNAME}"
OutFile "{{out_file}}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "{{version_with_build}}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME} test installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "DMeloper"
VIAddVersionKey "LegalCopyright" "DMeloper"
!if "{{installer_icon}}" != ""
Icon "{{installer_icon}}"
UninstallIcon "{{installer_icon}}"
!endif
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\Korean.nlf"
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
LangString DesktopPrompt 1033 "Installation is complete. Create a desktop shortcut?"
LangString DesktopPrompt 1042 "설치가 완료되었습니다. 바탕화면에 바로가기를 만드시겠습니까?"
LangString DesktopCreated 1033 "Desktop shortcut created."
LangString DesktopCreated 1042 "바탕화면 바로가기를 만들었습니다."
LangString DesktopCreateFailure 1033 "Installation is complete, but the desktop shortcut could not be created. You can open the app from the installation folder:$\r$\n$INSTDIR"
LangString DesktopCreateFailure 1042 "설치는 완료됐지만 바탕화면 바로가기를 만들지 못했습니다. 다음 설치 폴더에서 앱을 실행할 수 있습니다:$\r$\n$INSTDIR"
LangString DesktopReceiptFailure 1033 "Installation is complete and the desktop shortcut was created, but its removal record could not be saved. You may need to remove this shortcut manually when uninstalling."
LangString DesktopReceiptFailure 1042 "설치와 바탕화면 바로가기 생성은 완료됐지만 제거용 기록을 저장하지 못했습니다. 앱을 제거할 때 이 바로가기는 직접 삭제해야 할 수 있습니다."
FileErrorText "$(FileRetry)" "$(FileRetry)"
DirText "$(InstallHint)"
!if "{{license}}" != ""
LicenseData "{{license}}"
Page license SkipUpdatePage
!endif
Page directory SkipUpdatePage
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    SetErrorLevel 1633
    Abort
  ${EndIf}
  ${GetParameters} $0
  StrCpy $UpdateMode 0
  StrCpy $RestartAfterUpdate 0
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
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\DMeloper.BlockPet.Test.Installer") p .r0 ?e'
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

Section Install
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
    !error "manual-nsis must not contain an external executable"
  {{/each}}
  ClearErrors
  WriteUninstaller "$INSTDIR\uninstall.exe"
  !insertmacro CheckWrite
  ; Preserve existing shortcuts; remember the bytes of a newly created one.
  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" shortcut_done
  ClearErrors
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAIN}"
  !insertmacro CheckWrite
  CopyFiles /SILENT "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\start-menu-original.lnk"
  !insertmacro CheckWrite
shortcut_done:
  ClearErrors
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "DMeloper"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAIN}$\""
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "${UNINSTKEY}" "DeliveryMode" "manual-nsis"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  !insertmacro CheckWrite
  SetErrorLevel 0
SectionEnd

; Manual success starts the installed app after optional shortcut handling.
; Update success retains the explicit /R contract and shares the single launch.
Function .onInstSuccess
  ClearErrors
  Delete "$INSTDIR\.block-pet-installing"
  !insertmacro CheckWrite
  System::Call 'kernel32::CloseHandle(p $InstallerMutex)'
  StrCpy $InstallerMutex 0
  StrCmp $UpdateMode 1 0 manual_success
  StrCmp $RestartAfterUpdate 1 desktop_done install_done
manual_success:
  IfSilent desktop_done
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" desktop_done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "$(DesktopPrompt)" /SD IDNO IDNO desktop_done
  Call CreateDesktopShortcut
desktop_done:
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
  SetShellVarContext current
  SetRegView 64
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
  ; Shared Saved Games data is deliberately not part of this inventory.
  Call un.AcquireInstallerMutex
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
