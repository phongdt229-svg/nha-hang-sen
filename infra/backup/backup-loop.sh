#!/bin/sh
# Sao lưu nền PostgreSQL hằng đêm (pg_basebackup) + dọn bản cũ. WAL do Postgres tự chép liên tục
# vào /backups/wal (archive_command), nên khôi phục được tới thời điểm gần nhất (PITR).
set -eu

BASE=/backups/base
WAL=/backups/wal
HOUR=${BACKUP_HOUR:-3}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-7}

mkdir -p "$BASE" "$WAL"
# Postgres (uid 70 trong image alpine) cần ghi được thư mục WAL.
chown -R 70:70 /backups
chmod 700 "$WAL"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

backup() {
  ts=$(date '+%Y%m%dT%H%M%S')
  dir="$BASE/$ts"
  log "Bắt đầu sao lưu nền $ts"
  # -X none: WAL lấy từ kho lưu trữ; -c fast: checkpoint ngay, không chờ.
  if pg_basebackup -D "$dir.partial" -Ft -z -X none -c fast --label="nhs-$ts"; then
    mv "$dir.partial" "$dir"
    date '+%s' > "$dir/finished_at"
    chown -R 70:70 "$dir"
    log "Xong: $(du -sh "$dir" | cut -f1)"
  else
    rm -rf "$dir.partial"
    log "LỖI: sao lưu nền thất bại"
    return 1
  fi
  prune
  if [ -n "${BACKUP_SYNC_CMD:-}" ]; then
    log "Đồng bộ lên cloud"
    sh -c "$BACKUP_SYNC_CMD" || log "LỖI: đồng bộ cloud thất bại"
  fi
}

# Giữ KEEP_DAYS ngày bản nền (ít nhất 2 bản), xóa WAL cũ hơn bản nền cũ nhất còn giữ.
prune() {
  total=$(ls -1d "$BASE"/2* 2>/dev/null | wc -l)
  for d in $(ls -1d "$BASE"/2* 2>/dev/null | sort); do
    [ "$total" -le 2 ] && break
    if [ -n "$(find "$d" -maxdepth 0 -mtime +"$KEEP_DAYS")" ]; then
      log "Xóa bản nền cũ $(basename "$d")"
      rm -rf "$d"
      total=$((total - 1))
    fi
  done
  oldest=$(ls -1d "$BASE"/2* 2>/dev/null | sort | head -1)
  [ -n "$oldest" ] && find "$WAL" -type f ! -newer "$oldest/finished_at" -mmin +60 -delete || true
}

# Chưa có bản nền nào thì sao lưu ngay, không chờ tới đêm.
ls -1d "$BASE"/2* >/dev/null 2>&1 || backup || true

last_day=""
while true; do
  today=$(date '+%Y%m%d')
  if [ "$(date '+%H')" -ge "$HOUR" ] && [ "$today" != "$last_day" ] && ! ls -1d "$BASE/$today"T* >/dev/null 2>&1; then
    backup && last_day=$today || true
  fi
  sleep 300
done
