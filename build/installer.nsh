!include "nsProcess.nsh"

!macro killRunningAppProcesses
  DetailPrint "Closing running ${PRODUCT_NAME} processes..."
  ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $0
  ${nsProcess::KillProcess} "fund-tracker-electron.exe" $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "fund-tracker-electron.exe"'
  Pop $0

  InitPluginsDir
  FileOpen $0 "$PLUGINSDIR\kill-running-app.ps1" w
  FileWrite $0 "$$names = @('${PRODUCT_FILENAME}', 'fund-tracker-electron')$\r$\n"
  FileWrite $0 "$$images = @('${APP_EXECUTABLE_FILENAME}', 'fund-tracker-electron.exe')$\r$\n"
  FileWrite $0 "$$names | ForEach-Object { Stop-Process -Name $$_ -Force -ErrorAction SilentlyContinue }$\r$\n"
  FileWrite $0 "$$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)$\r$\n"
  FileWrite $0 "if (-not $$processes) { $$processes = @(Get-WmiObject Win32_Process -ErrorAction SilentlyContinue) }$\r$\n"
  FileWrite $0 "$$processes | Where-Object { $$images -contains $$_.Name } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\r$\n"
  FileClose $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\kill-running-app.ps1"'
  Pop $0
  Sleep 800
!macroend

!macro skipBrokenOldUninstaller
  !ifndef BUILD_UNINSTALLER
    DetailPrint "Skipping old uninstaller during repair install..."
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
      DeleteRegKey HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY_2}"
      DeleteRegKey HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
  !endif
!macroend

!macro preInit
  !insertmacro killRunningAppProcesses
!macroend

!macro customCheckAppRunning
  !insertmacro killRunningAppProcesses
  !insertmacro skipBrokenOldUninstaller
!macroend

!macro customUnInit
  !insertmacro killRunningAppProcesses
!macroend
