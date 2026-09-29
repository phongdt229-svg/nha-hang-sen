#!/bin/sh
# Diễn tập khôi phục (mục 17.4 Sprint 7): dựng một PostgreSQL mới từ bản nền gần nhất + WAL,
# so với database đang chạy, đo RTO (thời gian khôi phục) và RPO (dữ liệu có thể mất).
# Không đụng tới database đang phục vụ: chỉ đọc /backups và truy vấn đọc trên server nguồn.
set -eu

BASE=/backups/base
WAL=/backups/wal
DATA=/tmp/restore
PORT=5433
now() { date '+%s'; }
log() { echo "$(date '+%H:%M:%S') $*"; }

latest=$(ls -1d "$BASE"/2* 2>/dev/null | sort | tail -1 || true)
[ -n "$latest" ] || { echo "Chưa có bản sao lưu nền nào trong $BASE"; exit 1; }

# Mốc so sánh: sự kiện mới nhất trên server nguồn, rồi buộc đóng đoạn WAL hiện tại để nó được lưu trữ.
src_seq=$(psql -Atc "SELECT COALESCE(MAX(seq),0) FROM event_log")
src_at=$(psql -Atc "SELECT COALESCE(EXTRACT(EPOCH FROM MAX(created_at))::bigint,0) FROM event_log")
switched=$(psql -Atc "SELECT pg_walfile_name(pg_switch_wal())")
wal_wait=0
while [ $wal_wait -lt 90 ]; do
  [ "$(psql -Atc "SELECT COALESCE(last_archived_wal >= '$switched', false) FROM pg_stat_archiver")" = "t" ] && break
  sleep 1
  wal_wait=$((wal_wait + 1))
done
archived=$(psql -Atc "SELECT COALESCE(last_archived_wal,'(chưa có)') FROM pg_stat_archiver")
failed=$(psql -Atc "SELECT failed_count FROM pg_stat_archiver")
log "Nguồn: sự kiện mới nhất #$src_seq; WAL lưu trữ gần nhất $archived (lỗi lưu trữ: $failed)"

start=$(now)
log "Khôi phục từ bản nền $(basename "$latest")"
rm -rf "$DATA" && mkdir -p "$DATA" && chown postgres:postgres "$DATA" && chmod 700 "$DATA"
su postgres -c "tar -xzf $latest/base.tar.gz -C $DATA"
cat >> "$DATA/postgresql.auto.conf" <<EOF
restore_command = 'cp $WAL/%f %p'
recovery_target_action = 'promote'
archive_mode = 'off'
EOF
touch "$DATA/recovery.signal"
chown -R postgres:postgres "$DATA"
su postgres -c "pg_ctl -D $DATA -o '-p $PORT -c listen_addresses=' -l /tmp/restore.log -w -t 600 start" >/dev/null

# Chờ phát lại WAL xong và server mở ghi (thoát chế độ recovery).
while [ "$(su postgres -c "psql -p $PORT -h /var/run/postgresql -Atc 'SELECT pg_is_in_recovery()' nhs" 2>/dev/null || echo t)" != "f" ]; do sleep 1; done
end=$(now)

q() { su postgres -c "psql -p $PORT -h /var/run/postgresql -Atc \"$1\" nhs"; }
dst_seq=$(q "SELECT COALESCE(MAX(seq),0) FROM event_log")
dst_at=$(q "SELECT COALESCE(EXTRACT(EPOCH FROM MAX(created_at))::bigint,0) FROM event_log")
echo
echo "=== Kết quả diễn tập khôi phục ==="
printf '%-28s %s\n' "Bản nền" "$(basename "$latest")"
for t in orders bills payments einvoices event_log; do
  printf '%-28s nguồn %-8s khôi phục %s\n' "Số dòng $t" "$(psql -Atc "SELECT COUNT(*) FROM $t")" "$(q "SELECT COUNT(*) FROM $t")"
done
printf '%-28s nguồn #%s · khôi phục #%s\n' "Sự kiện mới nhất" "$src_seq" "$dst_seq"
printf '%-28s %s giây (mục tiêu < 900)\n' "RTO (dựng lại database)" "$((end - start))"
lost=$((src_seq - dst_seq))
gap=$((src_at - dst_at))
[ $gap -lt 0 ] && gap=0
printf '%-28s %s sự kiện, %s giây dữ liệu (mục tiêu < 300; tối đa archive_timeout=60 giây khi sự cố thật)\n' "RPO (dữ liệu mất)" "$lost" "$gap"
su postgres -c "pg_ctl -D $DATA -m fast stop" >/dev/null
rm -rf "$DATA"
[ "$lost" -le 0 ] && [ $((end - start)) -lt 900 ] && echo "ĐẠT" || { echo "KHÔNG ĐẠT — xem runbook mục Sao lưu"; exit 2; }
