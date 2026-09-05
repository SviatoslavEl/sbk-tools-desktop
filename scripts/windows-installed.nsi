Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompress off
CRCCheck on

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define PRODUCT_NAME "СБК Инструменты — быстрый запуск"
!define PRODUCT_ID "ru.sbk.tools.fast"
!define PRODUCT_PUBLISHER "СБК"
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
VIAddVersionKey "LegalCopyright" "© СБК"
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
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  StrCpy $StartMenuFolder "СБК Инструменты"
  IfSilent installation_allowed
  IfFileExists "$INSTDIR\${PRODUCT_EXE}" 0 installation_allowed
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
    "${PRODUCT_NAME} уже установлена.$\r$\n$\r$\nОбновить файлы программы? Пользовательские данные ProductData затронуты не будут." \
    IDYES installation_allowed
  Abort
installation_allowed:
FunctionEnd

Section "!${PRODUCT_NAME}" MainSection
  SectionIn RO
  SetOutPath "$PLUGINSDIR"
  File /oname=payload.tar.zst "payload.tar.zst"
  File /oname=sbk-installed-extractor.exe "sbk-installed-extractor.exe"

  ExecWait '"$PLUGINSDIR\sbk-installed-extractor.exe" "$PLUGINSDIR\payload.tar.zst" "$INSTDIR" "$TEMP\SBK-Tools-Fast-Install-Error.log"' $0
  ${If} $0 != "0"
    IfSilent silent_install_failure
    MessageBox MB_ICONSTOP|MB_OK "Не удалось установить ${PRODUCT_NAME}. Код ошибки: $0"
    Abort
silent_install_failure:
    SetErrorLevel 1
    Quit
  ${EndIf}

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
