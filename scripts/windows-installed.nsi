Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompress off
CRCCheck on

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define PRODUCT_NAME "СБК Инструменты — быстрый запуск"
!define PRODUCT_ID "ru.sbk.tools.fast"
!define PRODUCT_PUBLISHER "СБК"
!define PRODUCT_AUTHOR "Elbakide S.E."
!define PRODUCT_EXE "SBK-Tools-Fast.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}"
!define PRODUCT_KEY "Software\SBK\ToolsFast"

Name "${PRODUCT_NAME}"
OutFile "SBK-Tools-Fast-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\SBK Tools Fast"
InstallDirRegKey HKCU "${PRODUCT_KEY}" "InstallDir"

VIProductVersion "${VERSION_QUAD}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "FileDescription" "Установщик ${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "© 2026 ${PRODUCT_AUTHOR} · ${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"

!define MUI_ABORTWARNING
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_STARTMENUPAGE_DEFAULTFOLDER "СБК Инструменты"
!define MUI_STARTMENUPAGE_REGISTRY_ROOT HKCU
!define MUI_STARTMENUPAGE_REGISTRY_KEY "${PRODUCT_KEY}"
!define MUI_STARTMENUPAGE_REGISTRY_VALUENAME "StartMenuFolder"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXE}"

Var StartMenuFolder

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.txt"
!define MUI_DIRECTORYPAGE_TEXT_TOP "Установка не требует прав администратора. Выберите папку, в которую вам разрешено записывать файлы. Рекомендуется папка по умолчанию в профиле пользователя."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateInstallDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  FileOpen $4 "$TEMP\SBK-Tools-Fast-Install-Error.log" w
  FileWrite $4 "Installer initialized. Destination: $INSTDIR$\r$\n"
  FileClose $4
  StrCpy $StartMenuFolder "СБК Инструменты"
  ; Silent installs skip the directory page. Validate before NSIS prepares $INSTDIR.
  IfSilent 0 interactive_initialization
  Call ValidateInstallDirectory
  Goto installation_allowed
interactive_initialization:
  IfFileExists "$INSTDIR\${PRODUCT_EXE}" 0 installation_allowed
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
    "${PRODUCT_NAME} уже установлена.$\r$\n$\r$\nОбновить файлы программы? Пользовательские данные ProductData затронуты не будут." \
    IDYES installation_allowed
  Abort
installation_allowed:
FunctionEnd

Function ValidateInstallDirectory
  ; Updates are staged beside the installation, so the parent must be writable.
  ${GetParent} "$INSTDIR" $1
find_existing_parent:
  ; A wildcard can report an empty directory as absent. Inspect the directory itself.
  System::Call 'kernel32::GetFileAttributesW(w r1) i.r2'
  StrCmp $2 -1 missing_install_parent
  IntOp $2 $2 & 0x10
  StrCmp $2 0 invalid_install_directory probe_install_parent
missing_install_parent:
  ${GetParent} "$1" $2
  StrCmp $1 $2 invalid_install_directory
  StrCmp $2 "" invalid_install_directory
  StrCpy $1 $2
  Goto find_existing_parent
probe_install_parent:
  ClearErrors
  GetTempFileName $2 "$1"
  IfErrors invalid_install_directory
  StrCmp $2 "" invalid_install_directory
  ; Verify an actual writable handle, not just a generated temporary name.
  ClearErrors
  FileOpen $3 "$2" w
  IfErrors invalid_install_directory
  FileClose $3
  Delete "$2"
  Return
invalid_install_directory:
  FileOpen $4 "$TEMP\SBK-Tools-Fast-Install-Error.log" a
  FileWrite $4 "Directory is not writable: $INSTDIR (parent: $1)$\r$\n"
  FileClose $4
  IfSilent silent_directory_failure
  MessageBox MB_ICONEXCLAMATION|MB_OK "В выбранную папку нельзя установить программу: нет прав записи или путь недоступен.$\r$\n$\r$\nСистемные папки (например, Program Files и Windows) обычно требуют прав администратора.$\r$\n$\r$\nВыберите папку с обычными правами записи, например:$\r$\n$LOCALAPPDATA\Programs\SBK Tools Fast"
  Abort
silent_directory_failure:
  SetErrorLevel 5
  Quit
FunctionEnd

; Repeat only the safe operation; never close a user's process automatically.
Function ExplainInstallFailure
  IfSilent silent_operation_failure
  StrCpy $2 "Не удалось выполнить обновление. Подробности указаны в журнале."
  ClearErrors
  FileOpen $1 "$TEMP\SBK-Tools-Fast-Install-Error.log.message.txt" r
  IfErrors show_operation_failure
  FileSeek $1 2 SET
  StrCpy $2 ""
read_failure_message:
  ClearErrors
  FileReadUTF16LE $1 $3
  IfErrors close_failure_message
  StrCpy $2 "$2$3"
  Goto read_failure_message
close_failure_message:
  FileClose $1
show_operation_failure:
  MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "$2$\r$\n$\r$\nПосле устранения причины нажмите «Повторить».$\r$\nЖурнал: $TEMP\SBK-Tools-Fast-Install-Error.log" IDRETRY retry_operation
  Abort
retry_operation:
  Return
silent_operation_failure:
  SetErrorLevel 1
  Quit
FunctionEnd

Section "!${PRODUCT_NAME}" MainSection
  SectionIn RO
  Call ValidateInstallDirectory
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=sbk-installed-extractor.exe "sbk-installed-extractor.exe"

preflight_retry:
  Delete "$TEMP\SBK-Tools-Fast-Install-Error.log.message.txt"
  ClearErrors
  ExecWait '"$PLUGINSDIR\sbk-installed-extractor.exe" --check "$INSTDIR" "$TEMP\SBK-Tools-Fast-Install-Error.log"' $0
  IfErrors preflight_failed
  StrCmp $0 "0" preflight_ready
preflight_failed:
  Call ExplainInstallFailure
  Goto preflight_retry
preflight_ready:
  File /oname=payload.tar.zst "payload.tar.zst"
install_retry:
  Delete "$TEMP\SBK-Tools-Fast-Install-Error.log.message.txt"
  ClearErrors
  ExecWait '"$PLUGINSDIR\sbk-installed-extractor.exe" "$PLUGINSDIR\payload.tar.zst" "$INSTDIR" "$TEMP\SBK-Tools-Fast-Install-Error.log"' $0
  IfErrors install_failed
  ${If} $0 != "0"
    Goto install_failed
  ${EndIf}
  Goto install_ready
install_failed:
  IfSilent silent_install_failure
  Call ExplainInstallFailure
  Goto install_retry
silent_install_failure:
  SetErrorLevel 1
  Quit
install_ready:

  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  SetOutPath "$INSTDIR\licenses"
  File "NSIS-COPYING"
  WriteRegStr HKCU "${PRODUCT_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  SetShellVarContext current
  WriteRegStr HKCU "${PRODUCT_KEY}" "StartMenuFolder" "СБК Инструменты"
  CreateDirectory "$APPDATA\Microsoft\Windows\Start Menu\Programs\СБК Инструменты"
  CreateShortcut "$APPDATA\Microsoft\Windows\Start Menu\Programs\СБК Инструменты\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}"
  CreateShortcut "$APPDATA\Microsoft\Windows\Start Menu\Programs\СБК Инструменты\Удалить ${PRODUCT_NAME}.lnk" "$INSTDIR\uninstall.exe"
  IfFileExists "$APPDATA\Microsoft\Windows\Start Menu\Programs\СБК Инструменты\${PRODUCT_NAME}.lnk" shortcut_ready 0
  FileOpen $2 "$TEMP\SBK-Tools-Fast-Install-Error.log" w
  FileWrite $2 "Не удалось создать ярлык меню Пуск: $APPDATA\Microsoft\Windows\Start Menu\Programs\СБК Инструменты\${PRODUCT_NAME}.lnk$\r$\n"
  FileClose $2
  IfSilent silent_shortcut_failure
  MessageBox MB_ICONSTOP|MB_OK "Не удалось создать ярлык меню Пуск."
  Abort
silent_shortcut_failure:
  SetErrorLevel 1
  Quit
shortcut_ready:
SectionEnd

Section /o "Ярлык на рабочем столе" DesktopShortcutSection
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  StrCpy $0 ""
  IfFileExists "$INSTDIR\ProductData\*.*" 0 remove_program_files
  StrCpy $0 "$INSTDIR.__sbk_product_data"
  IfFileExists $0 preserve_collision 0
  ClearErrors
  Rename "$INSTDIR\ProductData" $0
  IfErrors preserve_failure 0
remove_program_files:
  ClearErrors
  RMDir /r "$INSTDIR"
  IfErrors removal_failure 0
  StrCmp $0 "" uninstall_complete
  CreateDirectory "$INSTDIR"
  ClearErrors
  Rename $0 "$INSTDIR\ProductData"
  IfErrors restore_failure 0
uninstall_complete:
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  ReadRegStr $StartMenuFolder HKCU "${PRODUCT_KEY}" "StartMenuFolder"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\$StartMenuFolder\${PRODUCT_NAME}.lnk"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\$StartMenuFolder\Удалить ${PRODUCT_NAME}.lnk"
  RMDir "$APPDATA\Microsoft\Windows\Start Menu\Programs\$StartMenuFolder"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
  Goto uninstall_done
preserve_collision:
  IfSilent silent_preserve_collision
  MessageBox MB_ICONSTOP|MB_OK "Не удалось безопасно удалить программу: временный каталог ProductData уже существует."
silent_preserve_collision:
  SetErrorLevel 1
  Quit
preserve_failure:
  IfSilent silent_preserve_failure
  MessageBox MB_ICONSTOP|MB_OK "Не удалось безопасно сохранить ProductData. Удаление отменено."
silent_preserve_failure:
  SetErrorLevel 1
  Quit
restore_failure:
  IfSilent silent_restore_failure
  MessageBox MB_ICONSTOP|MB_OK "Программа удалена, но ProductData осталась в безопасном каталоге: $0"
silent_restore_failure:
  SetErrorLevel 1
  Quit
removal_failure:
  StrCmp $0 "" silent_removal_failure
  CreateDirectory "$INSTDIR"
  ClearErrors
  Rename $0 "$INSTDIR\ProductData"
  IfErrors restore_failure 0
  IfSilent silent_removal_failure
  MessageBox MB_ICONSTOP|MB_OK "Не удалось полностью удалить файлы программы. ProductData восстановлена."
silent_removal_failure:
  SetErrorLevel 1
  Quit
uninstall_done:
SectionEnd
