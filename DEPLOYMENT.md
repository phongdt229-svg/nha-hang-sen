# Deployment Guide

## Local Development

```bash
# Install
pnpm install

# Run infrastructure
docker compose -f infra/docker-compose.yml up -d

# Run dev servers (all apps + API)
pnpm dev

# URLs:
# - Tablet: http://localhost:5173/tablet/
# - POS: http://localhost:5174/pos/
# - KDS: http://localhost:5175/kds/
# - API: http://localhost:3000
# - Grafana: http://localhost:3001 (user: admin / pass: sen123)
```

## Production Deployment

### 1. Build & Deploy

```bash
# Build Docker images
docker build -t nhs-api:latest -f apps/api/Dockerfile .
docker build -t nhs-web:latest -f infra/web.Dockerfile .

# Push to registry (e.g., DockerHub, ECR)
docker tag nhs-api:latest myregistry/nhs-api:latest
docker push myregistry/nhs-api:latest

# Deploy via docker-compose or Kubernetes
docker compose -f infra/docker-compose.yml up -d
```

### 2. Database Setup

```bash
# Run migrations
docker compose exec api pnpm prisma migrate deploy

# Seed initial data (optional)
docker compose exec api pnpm prisma db seed
```

### 3. Backup Strategy

```bash
# Enable automatic daily backups
# Add to crontab on server:
0 2 * * * cd /app && bash ./infra/backup.sh > /var/log/backup.log 2>&1

# To restore from backup:
bash ./infra/restore.sh infra/backups/backup_YYYYMMDD_HHMMSS.sql.gz
```

### 4. Monitoring

```bash
# Check Prometheus metrics
curl http://localhost:9090/api/v1/query?query=up

# View Grafana dashboards
# - http://localhost:3001
# - Setup alerts for order ACK latency, payment failures, printer issues
```

## Environment Variables

Required on production server:

```bash
# Database
DATABASE_URL=postgresql://nhs:PASSWORD@db-host:5432/nhs?schema=public

# Cache & Queue
REDIS_URL=redis://redis-host:6379

# API
JWT_SECRET=long-secure-random-string
PORT=3000

# MQTT (for robots)
MQTT_URL=mqtt://mqtt-host:1883

# Payment Gateway (when integrating real)
VNPAY_API_KEY=...
VNPAY_API_SECRET=...

# E-invoice Provider
EINVOICE_PROVIDER=real-provider-name
EINVOICE_API_KEY=...

# Monitoring
SENTRY_DSN=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

## Health Checks

```bash
# API readiness
curl http://localhost:3000/health/ready

# Database
curl http://localhost:3000/health/db

# Cache
curl http://localhost:3000/health/cache

# All systems
curl http://localhost:3000/health
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Containers won't start | Check `docker compose logs api` for errors |
| Database connection failed | Verify DATABASE_URL, run migrations |
| Backups not running | Check cron logs: `grep backup /var/log/syslog` |
| Orders stuck in SENT state | Check KDS connection, run manual ACK from POS |
| Memory issues | Increase Docker memory limit, clear old backups |

## Scaling (Multi-branch)

When ready for multiple locations:
1. Deploy separate database per branch (or shared with schema isolation)
2. Update API with branch context (middleware)
3. Replicate backups across regions
4. Setup cloud sync for reports & analytics

