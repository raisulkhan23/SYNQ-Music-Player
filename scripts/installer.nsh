; NSIS overrides for the SYNQ installer.
;
; Why the upgrade path fails while running the uninstaller by hand works: the
; installer calls the old uninstaller as
;   "$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA <currentuser|allusers> --updated _?=<install dir>
; and `--updated` is what selects the rename-into-$PLUGINSDIR branch below. A
; manual `Uninstall SYNQ.exe` has no --updated, so it deletes the files
; directly and succeeds.
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
; during an upgrade: the uninstaller aborts (exit code 2 for a failed rename,
; and it can fail at other points too) and electron-builder's default handling
; turns any non-zero code into "Failed to uninstall old application files" and
; a dead installer. Whatever the code, an existing installation is exactly
; what the installer is about to overwrite, so remove it directly and install.

!macro synqHandleUninstallResult
  ${if} $R0 != 0
    DetailPrint "Old uninstaller failed (exit $R0); removing $INSTDIR directly"
    SetOutPath $TEMP
    RMDir /r "$INSTDIR"
    ; The failed uninstaller did not get as far as its own cleanup, so drop its
    ; registration: without it the next install is not handed a dead uninstaller.
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro synqHandleUninstallResult
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro synqHandleUninstallResult
!macroend
