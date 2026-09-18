; ============================================================================
; Sakana 安装器自定义脚本
;
; v0.2.9：清理 %APPDATA%\sakana 残留 + 首次安装迁移旧数据；
;         并从此版开始把缓存与数据放在**应用安装目录**里（减少 C 盘占用）。
;
; v0.2.11：修两个「覆盖安装」上的硬伤（都由用户实测暴露）：
;
;   ① 报错 `Failed to uninstall old application files. Please try running the
;      installer again: 2` 并中止安装。
;      这句来自 electron-builder 的 handleUninstallResult(installUtil.nsh:129)，
;      `: 2` 是**旧版卸载器**的退出码 —— NSIS 卸载器只要在没先 SetErrorLevel 0 的
;      情况下提前 Quit，退出码就是 2（common.nsh 里那句 "avoid exit code 2" 的注释就是为它写的）。
;      而旧卸载器唯一会提前 Quit 的分支，是静默模式下「发现安装目录里还有进程在跑、
;      taskkill 又杀不掉」（allowOnlyOneInstallerInstance.nsh 的 CHECK_APP_RUNNING）——
;      静默安装时那个「关不掉」的对话框会被自动当成取消，于是 Quit → 退出码 2。
;      → 所以 customInit 里先把应用和它的辅助进程结束掉；并且直接清掉旧版本在注册表里的
;        卸载项，让安装器**跳过「先卸载旧版本」这一步**（同名文件本来就由安装器自己覆盖）。
;
;   ② 升级会把安装目录里的**用户数据一起删掉**。
;      旧卸载器在升级分支里是 `un.atomicRMDir` + `RMDir /r $INSTDIR`（uninstaller.nsh:164-187），
;      整个安装目录清空；而我们的数据根（收藏/订阅/观看进度/设置）就在 `$INSTDIR\data` 下。
;      → customInit 先把用户数据备份到 %TEMP%（只有几 MB 的 JSON），装完在 customInstall 还原；
;        另外给**我们自己这一版生成的卸载器**定义 customRemoveFiles，让它只删应用文件、
;        保留 `data`（覆盖升级时连 cache/下载/截图一起保留）。
;
; 两处兜底是有意的：跳过旧卸载器是第一道防线（正常路径下数据根本不会被碰），
; 备份/还原是第二道防线（万一注册表清理没生效，数据也不会丢）。
; ============================================================================

; ---------------------------------------------------------------------------
; 内部：结束还在运行的 Sakana 及其辅助进程
;
; 用 cmd 的 taskkill/tasklist 而不是插件，避免额外的 include 依赖与 32/64 位插件问题。
; nsExec::Exec 会把退出码压栈，每个都要 Pop 掉（不 Pop 会把栈搞脏，后面读到的值全是错的）。
; ---------------------------------------------------------------------------
!macro sakanaStopApp
  StrCpy $0 0
  sakana_stop_retry:
    IntOp $0 $0 + 1
    ; 先温和请求退出（应用自己会保存状态），再强制结束
    nsExec::Exec 'cmd /c taskkill /T /IM "${APP_EXECUTABLE_FILENAME}" >nul 2>nul'
    Pop $1
    Sleep 700
    nsExec::Exec 'cmd /c taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" >nul 2>nul'
    Pop $1
    ; 这些是我们自己拉起来的辅助进程，同样会占住安装目录里的可执行文件
    nsExec::Exec 'cmd /c taskkill /F /IM aria2c.exe >nul 2>nul'
    Pop $1
    nsExec::Exec 'cmd /c taskkill /F /IM ffmpeg.exe >nul 2>nul'
    Pop $1
    nsExec::Exec 'cmd /c taskkill /F /IM ffprobe.exe >nul 2>nul'
    Pop $1
    nsExec::Exec 'cmd /c taskkill /F /IM mpv.exe >nul 2>nul'
    Pop $1
    Sleep 500
    nsExec::Exec 'cmd /c tasklist /NH /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" | find /I "${APP_EXECUTABLE_FILENAME}" >nul 2>nul'
    Pop $1
    ; $1 == 0 → 还在运行，再试一轮；最多 6 轮
    IntCmp $1 0 0 sakana_stop_done sakana_stop_done
    IntCmp $0 6 sakana_stop_done sakana_stop_retry sakana_stop_retry
  sakana_stop_done:
!macroend

; ---------------------------------------------------------------------------
; 安装最开始（.onInit）：结束进程 + 备份用户数据 + 清掉旧卸载项
; ---------------------------------------------------------------------------
!macro customInit
  !insertmacro sakanaStopApp

  ; 备份用户数据（几 MB 的 JSON）：旧卸载器升级时会清空安装目录
  IfFileExists "$INSTDIR\data\userData\data\*.*" 0 sakana_no_backup
    RMDir /r "$TEMP\sakana-userdata-backup"
    nsExec::Exec 'cmd /c xcopy /E /I /Y /Q "$INSTDIR\data\userData\data" "$TEMP\sakana-userdata-backup\data" >nul 2>nul'
    Pop $0
    DetailPrint "已备份用户数据（收藏 / 订阅 / 观看进度 / 设置）"
  sakana_no_backup:

  ; 清掉旧版本的「卸载」注册表项 → 安装器不会再调用旧卸载器（它才是清空安装目录的那位）
  ClearErrors
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ClearErrors
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  ClearErrors
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ClearErrors
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  ClearErrors
!macroend

; ---------------------------------------------------------------------------
; 文件复制完之后：还原用户数据 + 首次安装迁移 + 清理 Roaming 残留
; ---------------------------------------------------------------------------
!macro customInstall
  ; 第二道防线：如果安装目录里的用户数据不见了（旧卸载器清空过），从备份还原
  IfFileExists "$TEMP\sakana-userdata-backup\*.*" 0 sakana_no_restore
    IfFileExists "$INSTDIR\data\userData\data\*.json" sakana_skip_restore
      CreateDirectory "$INSTDIR\data\userData\data"
      CopyFiles /SILENT "$TEMP\sakana-userdata-backup\data\*.*" "$INSTDIR\data\userData\data"
      DetailPrint "已还原用户数据（收藏 / 订阅 / 观看进度 / 设置）"
    sakana_skip_restore:
    RMDir /r "$TEMP\sakana-userdata-backup"
  sakana_no_restore:

  ; v0.2.9 起的首次安装迁移：只在「安装目录下还没有数据根」时执行
  ; 刻意不迁移 settings.json —— 用户反馈过旧配置残留会让「不优先使用反代地址」的老毛病复发
  IfFileExists "$INSTDIR\data\userData\*.*" sakana_skip_migrate
  IfFileExists "$APPDATA\sakana\data\*.json" 0 sakana_skip_migrate
    CreateDirectory "$INSTDIR\data\userData\data"
    CopyFiles /SILENT "$APPDATA\sakana\data\*.json" "$INSTDIR\data\userData\data"
    Delete "$INSTDIR\data\userData\data\settings.json"
    DetailPrint "已迁移旧版本的收藏 / 订阅 / 观看进度（不迁移旧设置与缓存）"
  sakana_skip_migrate:

  ; 按用户要求清掉旧目录（此后应用只读安装目录下的数据根）
  IfFileExists "$APPDATA\sakana\*.*" 0 sakana_skip_purge
    DetailPrint "正在清理旧版本残留在 Roaming 下的数据…"
    RMDir /r "$APPDATA\sakana"
  sakana_skip_purge:
!macroend

; ---------------------------------------------------------------------------
; 应用是否还在运行：把默认的「关不掉就退出」换成「尽力结束，绝不让安装中止」
;
; 默认实现在静默模式下杀不掉进程时会 MessageBox(/SD IDCANCEL) + Quit，
; 卸载器这样一来退出码就是 2，新安装器随即报错中止 —— 这是我们这一版要根除的故障。
; ---------------------------------------------------------------------------
!macro customCheckAppRunning
  !insertmacro sakanaStopApp

  nsExec::Exec 'cmd /c tasklist /NH /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" | find /I "${APP_EXECUTABLE_FILENAME}" >nul 2>nul'
  Pop $1
  IntCmp $1 0 0 sakana_check_done sakana_check_done
  ; 还有残留（多半是以管理员身份启动的实例，普通权限杀不掉）：给一句能照着做的提示，
  ; 静默安装（应用内一键更新）时没有人能看对话框，就只记日志，绝不用弹窗把安装卡住
  IfSilent sakana_check_silent
  MessageBox MB_OK|MB_ICONEXCLAMATION "检测到 Sakana 仍在运行（可能是以管理员身份启动的实例）。$\r$\n请先退出应用（含右下角托盘图标）再重新运行安装程序，否则可能因为文件被占用而失败。"
  Goto sakana_check_done
  sakana_check_silent:
  DetailPrint "Sakana 仍在运行且未能结束；继续安装可能因文件占用失败。"
  sakana_check_done:
!macroend

; ---------------------------------------------------------------------------
; 卸载时删除哪些文件（我们自己这一版生成的卸载器走这里）
;
; 默认行为是 RMDir /r $INSTDIR —— 会把安装目录里的用户数据一起删掉。
; 这里改成：只删应用文件，保留 data（用户数据），覆盖升级时连缓存与用户文件一起保留。
; ---------------------------------------------------------------------------
!macro customRemoveFiles
  StrCpy $2 ""
  ${if} ${isUpdated}
    StrCpy $2 "1"
  ${endif}

  ClearErrors
  FindFirst $0 $1 "$INSTDIR\*.*"
  sakana_rm_loop:
    StrCmp $1 "" sakana_rm_done
    StrCmp $1 "." sakana_rm_next
    StrCmp $1 ".." sakana_rm_next
    ; data 永远保留：收藏 / 订阅 / 观看进度 / 设置都在里面
    StrCmp $1 "data" sakana_rm_next
    StrCmp $2 "1" 0 sakana_rm_no_keep
      ; 覆盖升级：缓存与用户自己的文件也保留（下载/截图早已另存到「文档\Sakana-backup」）
      StrCmp $1 "cache" sakana_rm_next
      StrCmp $1 "downloads" sakana_rm_next
      StrCmp $1 "screenshots" sakana_rm_next
      StrCmp $1 "galgame-screenshots" sakana_rm_next
    sakana_rm_no_keep:
    IfFileExists "$INSTDIR\$1\*.*" 0 sakana_rm_file
      RMDir /r "$INSTDIR\$1"
      Goto sakana_rm_next
    sakana_rm_file:
      Delete "$INSTDIR\$1"
    sakana_rm_next:
      FindNext $0 $1
      Goto sakana_rm_loop
  sakana_rm_done:
    FindClose $0
    ; 不带 /r：目录里还有保留内容时删不掉，正好
    RMDir "$INSTDIR"
!macroend

; ---------------------------------------------------------------------------
; 卸载前：把用户自己下载的文件与截图备份到「文档\Sakana-backup」
; ---------------------------------------------------------------------------
!macro customUnInstall
  nsExec::Exec 'cmd /c if exist "$INSTDIR\downloads" xcopy /E /I /Y /Q "$INSTDIR\downloads" "$DOCUMENTS\Sakana-backup\downloads" >nul 2>nul'
  Pop $0
  nsExec::Exec 'cmd /c if exist "$INSTDIR\screenshots" xcopy /E /I /Y /Q "$INSTDIR\screenshots" "$DOCUMENTS\Sakana-backup\screenshots" >nul 2>nul'
  Pop $0
  nsExec::Exec 'cmd /c if exist "$INSTDIR\galgame-screenshots" xcopy /E /I /Y /Q "$INSTDIR\galgame-screenshots" "$DOCUMENTS\Sakana-backup\galgame-screenshots" >nul 2>nul'
  Pop $0
  ; 数据根在安装目录里，卸载会删掉它 —— 这里明确告诉用户数据留在哪里
  IfFileExists "$INSTDIR\data\userData\data\*.*" 0 sakana_un_done
    DetailPrint "用户数据（收藏 / 订阅 / 观看进度）保留在 $INSTDIR\data\userData\data"
  sakana_un_done:
!macroend
