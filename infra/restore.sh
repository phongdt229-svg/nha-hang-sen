#!/bin/bash
# Restore database from backup file
# Usage: ./restore.sh infra/backups/backup_20261001_120000.sql.gz

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <backup-file>"
  echo "Example: $0 infra/backups/backup_20261001_120000.sql.gz"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Database credentials
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-nhs}"
DB_NAME="${DB_NAME:-nhs}"
DB_PASSWORD="${DB_PASSWORD:-nhs}"

echo "⚠️  WARNING: This will overwrite the current database!"
echo "📁 Backup file: $BACKUP_FILE"
echo "💾 Database: $DB_NAME on $DB_HOST:$DB_PORT"
echo ""

read -p "Type 'restore' to confirm: " confirm
if [ "$confirm" != "restore" ]; then
  echo "❌ Cancelled"
  exit 1
fi

echo ""
echo "🔄 Dropping current database..."
export PGPASSWORD="$DB_PASSWORD"

# Drop existing database
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS $DB_NAME;"

# Create new database
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
  -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

echo "✅ Database recreated"
echo ""
echo "🔄 Restoring from backup..."

# Restore from backup
if [[ "$BACKUP_FILE" == *.gz ]]; then
  gunzip -c "$BACKUP_FILE" | psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
else
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" < "$BACKUP_FILE"
fi

echo ""
echo "✅ Restore complete!"
echo "📊 Restored from: $BACKUP_FILE"
echo ""
echo "⚡ Next steps:"
echo "1. Verify data: SELECT COUNT(*) FROM orders;"
echo "2. Restart API server"
echo "3. Clear browser cache"
