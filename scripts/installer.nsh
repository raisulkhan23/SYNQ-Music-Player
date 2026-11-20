; NSIS overrides for the SYNQ installer.
;
; electron-builder uninstalls the previous version during an upgrade by
; renaming every file in $INSTDIR into "$PLUGINSDIR\old-install". That moves
; paths under a much longer prefix, and NSIS is not long-path aware, so any
; file whose path crosses MAX_PATH (260 characters) cannot be renamed. The
; uninstaller then aborts with exit code 2 and the installer reports
; "Failed to uninstall old application files". A plain recursive delete does
; work on those paths, so the atomic rename is tried first (it lets a failed
; update roll back) and the delete is used when the rename cannot complete.

!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "Cannot rename $R0, removing the old install directly"

      ; Put back what did move, so an aborted update still leaves a working app.
      Push ""
      Call un.restoreFiles
      Pop $R0

      SetOutPath $TEMP
      RMDir /r $INSTDIR
    ${endif}
  ${else}
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${endif}
!macroend

; Releases up to 1.0.1 shipped a production node_modules with paths past
; MAX_PATH, so an installation made by one of them cannot uninstall itself
; during an upgrade: it aborts with exit code 2 and electron-builder's default
; handling quit the installer with that code. Remove such an installation
; directly and let the upgrade continue.

!macro synqRemoveStaleInstall
  DetailPrint "Old uninstaller failed (exit $R0); removing $INSTDIR directly"
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
  ; The aborted uninstaller did not get as far as its own cleanup, so drop its
  ; registration: without it the next upgrade has no dead uninstaller to run.
  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
!macroend

!macro synqHandleUninstallResult
  ${if} $R0 == 2
    !insertmacro synqRemoveStaleInstall
  ${elseif} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro synqHandleUninstallResult
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro synqHandleUninstallResult
!macroend
