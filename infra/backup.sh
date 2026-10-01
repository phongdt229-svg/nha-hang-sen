#!/bin/bash
# Backup database daily to ./backups/{date}.sql.gz

set -e

BACKUP_DIR="./backups"
mkdir -p "$BACKUP_DIR"

# Database credentials from environment or defaults
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-nhs}"
DB_NAME="${DB_NAME:-nhs}"
DB_PASSWORD="${DB_PASSWORD:-nhs}"

# Backup filename with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql.gz"

echo "🔄 Backing up database to $BACKUP_FILE..."

# Use PGPASSWORD to avoid password prompt
export PGPASSWORD="$DB_PASSWORD"

# Dump database (exclude large log tables)
pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --exclude-table="event_log" \
  --exclude-table="audit_log" \
  --exclude-table="webhook_logs" \
  | gzip > "$BACKUP_FILE"

# Keep only last 30 backups
find "$BACKUP_DIR" -name "backup_*.sql.gz" -type f | sort -r | tail -n +31 | xargs -r rm

echo "✅ Backup complete: $BACKUP_FILE"
echo "📊 Backup size: $(du -h "$BACKUP_FILE" | cut -f1)"

# List recent backups
echo ""
echo "📋 Recent backups (last 5):"
ls -lh "$BACKUP_DIR"/backup_*.sql.gz | tail -5 | awk '{print $9, "(" $5 ")"}'
