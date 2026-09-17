; ============================================================================
; Sakana 安装器自定义脚本（v0.2.9 最后更新）
;
; 用户要求：
;   1) 本次安装清除旧版本留在 Roaming 下的 sakana 全部文件
;      （旧缓存/旧设置残留会让「不优先使用反代地址」的老毛病在卸载重装后复发）；
;   2) 从这个版本开始，缓存与数据都放在**应用安装目录**里，最大限度减少 C 盘占用。
;
; 所以这里的处理顺序是：先把旧数据里**用户不可再生**的部分搬到安装目录下的新数据根，
; 再按用户要求把整个 `%APPDATA%\sakana` 删掉。
; 刻意**不迁移 settings.json** —— 用户反馈的毛病正是旧配置残留造成的；
; 不迁移它，新版本就会用上内置的反代默认值。
; ============================================================================

!macro customInstall
  ; 只在「首次安装」时迁移：安装目录下已经有数据根（说明是覆盖升级）就不再动用户数据
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

!macro customUnInstall
  ; 用户数据现在就在安装目录里，卸载会被一并删除 ——
  ; 卸载前先备份下载/截图，避免把用户自己的文件当成应用文件清掉。
  nsExec::Exec 'cmd /c if exist "$INSTDIR\downloads" xcopy /E /I /Y "$INSTDIR\downloads" "$DOCUMENTS\Sakana-backup\downloads" >nul 2>nul'
  nsExec::Exec 'cmd /c if exist "$INSTDIR\screenshots" xcopy /E /I /Y "$INSTDIR\screenshots" "$DOCUMENTS\Sakana-backup\screenshots" >nul 2>nul'
  nsExec::Exec 'cmd /c if exist "$INSTDIR\galgame-screenshots" xcopy /E /I /Y "$INSTDIR\galgame-screenshots" "$DOCUMENTS\Sakana-backup\galgame-screenshots" >nul 2>nul'
!macroend
