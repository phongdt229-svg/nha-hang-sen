# Sao lưu & khôi phục PostgreSQL

Mục tiêu (mục 17.2): **RPO < 5 phút**, **RTO < 15 phút**.

## Cách hoạt động

| Thành phần | Việc |
|---|---|
| `postgres` (`archive_mode=on`, `archive_timeout=60`) | Chép liên tục từng đoạn WAL vào volume `backups` (`/backups/wal`). Quán vắng vẫn đóng đoạn ít nhất mỗi phút → dữ liệu chưa lưu tối đa ~60 giây. |
| `backup` ([backup-loop.sh](backup-loop.sh)) | Sao lưu nền `pg_basebackup` lúc `BACKUP_HOUR` giờ sáng (mặc định 3h, giờ Việt Nam) vào `/backups/base/<thời điểm>`; lần đầu chạy thì sao lưu ngay. Giữ `BACKUP_KEEP_DAYS` ngày (ít nhất 2 bản), xóa WAL cũ hơn bản nền cũ nhất. |
| `BACKUP_SYNC_CMD` | Lệnh đẩy `/backups` lên cloud sau mỗi lần sao lưu nền. Để trống thì chỉ lưu trên server tại quán. |
| `restore-drill` ([restore-drill.sh](restore-drill.sh)) | Diễn tập: dựng database mới từ bản nền + WAL, so với database đang chạy, in RTO/RPO. Không đụng tới database đang phục vụ. |

> **Bắt buộc có bản sao ngoài server**: ổ đĩa server hỏng thì volume `backups` mất theo. Đồng bộ lên cloud (S3, Google Drive qua rclone…) hoặc ít nhất một ổ USB/NAS khác máy.

Ví dụ đẩy lên S3 (cần image có `aws` CLI, hoặc chạy lệnh đồng bộ trên máy chủ bằng cron thay vì trong container):

```bash
BACKUP_SYNC_CMD="aws s3 sync /backups s3://nha-hang-sen-backup/chi-nhanh-1 --delete"
```

## Kiểm tra hằng ngày

```bash
docker compose -f infra/docker-compose.yml logs --tail 20 backup      # "Xong: …" mỗi đêm
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U nhs -d nhs -c "SELECT archived_count, last_archived_time, failed_count FROM pg_stat_archiver"
```

`failed_count` tăng dần = WAL không lưu được (volume đầy, sai quyền) → xử lý ngay, vì Postgres giữ WAL chưa lưu trên ổ dữ liệu cho tới khi lưu được.

## Diễn tập khôi phục (mỗi tháng)

```bash
docker compose -f infra/docker-compose.yml --profile drill run --rm restore-drill
```

Kết quả mẫu (máy dev, 29/09/2026, có 3 order tạo **sau** bản nền để kiểm tra phát lại WAL):

```
Số dòng orders            nguồn 9        khôi phục 9
Sự kiện mới nhất          nguồn #123 · khôi phục #123
RTO (dựng lại database)   4 giây (mục tiêu < 900)
RPO (dữ liệu mất)         0 sự kiện, 0 giây dữ liệu
ĐẠT
```

RTO ở đây chỉ gồm dựng lại database. RTO thật còn cộng thời gian khởi động API/web (khoảng 1 phút) và chép bản sao lưu từ cloud về nếu server cũ hỏng hẳn — đo lại lần đầu tại quán với dữ liệu thật.

## Khôi phục thật

Khi database hỏng hoặc thay server. Làm ngoài giờ phục vụ nếu được; trong giờ thì quán chuyển sang ghi tay.

1. Dừng API để không ai ghi thêm: `docker compose -f infra/docker-compose.yml stop api web`.
2. Có volume `backups` (hoặc chép bản cloud về một thư mục trên server mới).
3. Tạo database mới từ bản nền gần nhất:

   ```bash
   docker compose -f infra/docker-compose.yml stop postgres
   docker volume rm nha-hang-sen_pgdata          # database hỏng — chỉ xóa khi chắc chắn có bản sao lưu
   docker run --rm -v nha-hang-sen_pgdata:/data -v nha-hang-sen_backups:/backups postgres:16-alpine sh -c '
     latest=$(ls -1d /backups/base/2* | sort | tail -1) &&
     tar -xzf $latest/base.tar.gz -C /data &&
     echo "restore_command = '"'"'cp /backups/wal/%f %p'"'"'" >> /data/postgresql.auto.conf &&
     touch /data/recovery.signal && chown -R 70:70 /data && chmod 700 /data'
   docker compose -f infra/docker-compose.yml up -d postgres
   ```

   Postgres phát lại toàn bộ WAL rồi tự mở ghi. Theo dõi: `docker compose … logs -f postgres` tới dòng `database system is ready to accept connections`.
4. Chạy lại mọi dịch vụ: `docker compose -f infra/docker-compose.yml up -d`, kiểm tra `http://server:3000/health/ready`.
5. **Muốn khôi phục về một thời điểm** (ví dụ trước lần cập nhật lỗi lúc 22:15): thêm `recovery_target_time = '2026-09-29 22:10:00+07'` vào `postgresql.auto.conf` ở bước 3.
