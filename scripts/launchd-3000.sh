#!/bin/zsh
# 登入自啟：把 3000 本機服務（Next start + Ollama + 3111 轉址）交給 launchd 使用者代理程式管理。
# 只開服務，不自動生成：舊管線自動續跑由 YT_SUMMARY_AUTO_RESUME 控制，這裡不設定（預設關閉）。
#
#   scripts/launchd-3000.sh install    寫入 plist 並 bootstrap（登入即啟動、當掉自動重啟）
#   SUBTITLE_REVIEW_MODEL=translategemma:12b scripts/launchd-3000.sh install   語意校訂改用另一個本機模型
#   scripts/launchd-3000.sh status     launchd 狀態 + 3000/3111/11434 是否在聽
#   scripts/launchd-3000.sh restart    kickstart -k（停掉再拉起，部署新 build 後用）
#   scripts/launchd-3000.sh stop       bootout（停止並取消自啟，plist 檔保留）
#   scripts/launchd-3000.sh uninstall  bootout + 刪 plist
set -euo pipefail

LABEL="com.vjvan.yt-summary-gallery"
ROOT="${YT_SUMMARY_ROOT:-$HOME/yt-summary-gallery}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
DOMAIN="gui/$(id -u)"
LOG_DIR="$ROOT/data"

# install 時 shell 有設 SUBTITLE_REVIEW_MODEL 就寫進 plist（語意校訂用另一個本機模型），沒設就不寫。
review_model_entry() {
  if [ -n "${SUBTITLE_REVIEW_MODEL:-}" ]; then
    printf '        <key>SUBTITLE_REVIEW_MODEL</key>\n        <string>%s</string>' "$SUBTITLE_REVIEW_MODEL"
  fi
}

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$ROOT/scripts/start-watch-local.mjs</string>
        <string>--port</string>
        <string>3000</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$ROOT</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
        <key>WATCH_PROCESSING_MODE</key>
        <string>local</string>
$(review_model_entry)
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>15</integer>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/launchd-3000.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/launchd-3000.err.log</string>
</dict>
</plist>
PLIST
  plutil -lint "$PLIST" >/dev/null
}

listening() {
  for port in 3000 3111 11434; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "  $port: 在聽"; else echo "  $port: 沒在聽"; fi
  done
}

case "${1:-status}" in
  install)
    [ -x "$NODE_BIN" ] || { echo "找不到 node：$NODE_BIN"; exit 1; }
    [ -f "$ROOT/scripts/start-watch-local.mjs" ] || { echo "找不到啟動器：$ROOT"; exit 1; }
    if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "3000 已有非 launchd 管的服務在聽，請先停掉它（例如 kill 對應的 start-watch-local 程序）再 install。"; exit 1
    fi
    write_plist
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl enable "$DOMAIN/$LABEL"
    echo "已安裝 $LABEL（登入自啟、當掉自動重啟）。log：$LOG_DIR/launchd-3000.log"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit" | sed 's/^/  /'
    else
      echo "  launchd：未安裝或未載入"
    fi
    listening
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "已要求 launchd 重啟 $LABEL"
    ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL"
    echo "已停止並取消自啟（plist 仍在 $PLIST，要恢復跑 install）"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    echo "已移除 $LABEL"
    ;;
  *)
    echo "用法：$0 {install|status|restart|stop|uninstall}"; exit 2
    ;;
esac
