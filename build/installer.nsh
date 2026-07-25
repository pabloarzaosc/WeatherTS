!macro customInstall
  DetailPrint "Installing Visual C++ Redistributable (if missing)..."
  SetOutPath $INSTDIR
  File "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  ExecWait '"$INSTDIR\vc_redist.x64.exe" /install /quiet /norestart'
  Delete "$INSTDIR\vc_redist.x64.exe"
!macroend
