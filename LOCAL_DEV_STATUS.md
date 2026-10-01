# Nha Hang Sen — Local Development Environment

## Status: ✅ Starting Up

**Date:** 2026-10-01
**Phase:** Phase 2 Sprint 1-3 Complete

---

## What's Running

### Docker Infrastructure ✅
- **PostgreSQL 16** (localhost:5432) — Database `nhs` ready
  - Migrations: 10 applied (including Phase 2 Sprint 1)
  - Seeded with test data
- **Redis 7** (localhost:6379) — Cache & queues (BullMQ)
- **MQTT** (mosquitto) — Robot & device messaging
- **Prometheus/Grafana** — Monitoring stack
- **Backup service** — Automated backups

### API Server 🔄 Starting
- **NestJS + Prisma** (port 8000)
- Status: Compiling TypeScript
- Fix applied: backup.controller.ts type error
- Will be ready in 30-60 seconds

### Database ✅
- **Migrations:** All Phase 2 models (Ingredient, Recipe, Stock, AI, Promotion)
- **Test Users:** admin / quanly / thungan / phucvu / bep / ketoan (password: `sen123`)

---

## Phase 2 Sprint Status

| Sprint | Status | What's Done |
|---|---|---|
| **Sprint 1** | ✅ COMPLETE | Inventory schema + InventoryService (receive, deduct, adjust) |
| **Sprint 2** | ✅ COMPLETE | Auto-deduct on PREPARING + auto-sold-out + events |
| **Sprint 3** | ✅ COMPLETE | AI chatbot (FastAPI, rule-based suggester, Anthropic-ready) |
| **Sprint 4** | ⏳ TODO | Food cost + Promotions (schema ready, service layer needed) |

---

## Quick Start Commands

### Terminal 1: Keep infrastructure running
```bash
cd C:\xampp\htdocs\nha-hang-sen
pnpm infra:up   # Already started, Ctrl+C to stop
```

### Terminal 2: API development
```bash
cd C:\xampp\htdocs\nha-hang-sen\apps\api
pnpm dev        # Runs: prisma generate && nest start --watch
```

### Terminal 3: AI service (Python)
```bash
cd C:\xampp\htdocs\nha-hang-sen\apps\ai
pip install -e .
python -m uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

---

## Environment

### Database Connection
```
DATABASE_URL=postgresql://nhs:nhafood@localhost:5432/nhs
```

### Redis
```
REDIS_URL=redis://localhost:6379
```

### API Test Credentials
- **Admin:** admin / sen123
- **Manager:** quanly / sen123
- **Cashier:** thungan / sen123
- **Kitchen:** bep / sen123
- **Accountant:** ketoan / sen123

---

## Testing Phase 2 Features

### 1. Inventory (POST to API)
```bash
# Receive stock
POST http://localhost:8000/stock/receive
{
  "ingredientId": "...",
  "qty": 100,
  "unitCost": 5000,
  "lotNumber": "LOT-20261001"
}

# Get current levels
GET http://localhost:8000/stock/levels
```

### 2. Auto-Deduct on PREPARING
- Create order → confirm
- KDS receives ticket
- Update order-item status → PREPARING
- ➜ Stock auto-deducted ✅
- Check: `GET /stock/levels` should show qty reduced

### 3. Auto-Sold-Out
- Receive recipe: 100 qty, 2 portions per order
- After 50 orders of that item → ingredient = 0
- ➜ MenuItem.available = false automatically ✅

### 4. AI Chatbot (port 8001)
```bash
POST http://localhost:8001/chat
{
  "message": "Tôi muốn ăn phở",
  "session_id": "SESSION-001",
  "menu": [{...}]
}
```
Response: `{reply: "Gợi ý...", suggestions: [{menu_item_id: "...", qty: 1}]}`

---

## Next Steps

### Immediate (this week)
1. ✅ Start local API + AI
2. ⏳ Integration test: inventory → order → KDS → stock deduction
3. ⏳ Add POST /ai/chat to API (bridge to apps/ai)
4. ⏳ Tablet chat UI (apps/tablet)

### Sprint 4 (next 1-2 weeks)
5. ⏳ Food cost reports (weighted-moving-average from stock)
6. ⏳ Promotion/Voucher service
7. ⏳ E2E tests: all scenarios from spec section 15

### CI/CD
- GitHub Actions ready (apps/api, apps/ai)
- Docker builds included
- Ready for staging/prod deploy

---

## Troubleshooting

### API won't start
- Check: `docker ps` — all services healthy?
- Check: DATABASE_URL in `.env`
- Check: TypeScript errors in `pnpm typecheck`

### Database errors
- Migrations applied? `pnpm db:migrate`
- Seeded? `pnpm db:seed`
- Check logs: `docker logs nha-hang-sen-postgres-1`

### AI service not responding
- Port 8001 free?
- Python 3.12+? `python --version`
- Install deps: `pip install -e .` in `apps/ai`

---

## Documentation

- **Technical Spec:** `docs/tai-lieu-cong-nghe-nha-hang-thong-minh-v0.7-mbot-demo-luckibot-pro.md`
- **Architecture:** Sprint 1 design in this commit
- **API:** Swagger at `http://localhost:8000/api` (when API running)

---

**Last Updated:** 2026-10-01 (Phase 2 Sprint 1-3 checkpoint)
**Next Review:** After Sprint 4 completion
