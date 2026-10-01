# Phase 2 Local Testing Guide

## Current Status (2026-10-01)

✅ **Phase 2 Sprints 1-3 Complete**
- All TypeScript errors fixed ✅
- API should be starting now (check port 8000)
- Database ready with migrations
- AI service ready (port 8001)

---

## Quick Start (3 Terminals)

### Terminal 1: Infrastructure (already running)
```bash
cd C:\xampp\htdocs\nha-hang-sen
pnpm infra:up
# Docker containers: postgres, redis, mqtt, prometheus, grafana ✅
```

### Terminal 2: API Server
```bash
cd C:\xampp\htdocs\nha-hang-sen\apps\api
pnpm dev
# Watch for: "[Nest] PORT 8000 listening"
# Expected: ~20-30 seconds for first compile
```

### Terminal 3: AI Service (Optional)
```bash
cd C:\xampp\htdocs\nha-hang-sen\apps\ai
pip install -e .
python -m uvicorn main:app --reload --port 8001
```

---

## Test Scenarios

### 1️⃣ **Test: Receive Stock (Create Ingredient)**

```bash
# Terminal: curl or Postman

# 1. Get auth token
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"phucvu","password":"sen123"}'

# Copy token from response, use as: -H "Authorization: Bearer TOKEN"

# 2. Create ingredient (optional - seeds may have some)
POST http://localhost:8000/ingredients
{
  "code": "GA001",
  "name": "Gạo trắng",
  "group": "ngũ cốc",
  "unit": "kg",
  "minStock": 10,
  "trackLots": false
}

# 3. Receive stock
POST http://localhost:8000/stock/receive
{
  "ingredientId": "UUID_FROM_CREATE_OR_SEED",
  "qty": 50,
  "unitCost": 20000,
  "lotNumber": "LOT-20261001"
}

# 4. Check levels
GET http://localhost:8000/stock/levels
# Should show currentStock: 50
```

### 2️⃣ **Test: Auto-Deduct on PREPARING**

```bash
# 1. Create menu item with recipe
POST http://localhost:8000/menu/MENU_ID/recipe
{
  "ingredients": [
    {
      "ingredientId": "GA001_UUID",
      "qty": 0.5,
      "wastePercent": 5
    }
  ]
}

# 2. Create order
POST http://localhost:8000/sessions/SESSION_ID/orders
{
  "items": [
    {
      "menuItemId": "MENU_ID",
      "qty": 2,
      "note": ""
    }
  ]
}
# Save orderId

# 3. KDS ACK
POST http://localhost:8000/kitchen/tickets/TICKET_ID/ack

# 4. Update to PREPARING (THIS TRIGGERS DEDUCTION!)
PATCH http://localhost:8000/order-items/ORDER_ITEM_ID/status
{
  "status": "PREPARING"
}
# Expected: Stock deducts = 2 qty × 0.5 unit/portion × 1.05 (5% waste) = 1.05 kg

# 5. Check stock levels
GET http://localhost:8000/stock/levels
# Should show currentStock: 48.95 (50 - 1.05)

# 6. If you deduct all (48 more orders), next order fails:
# Response: "Insufficient stock: Need 1.05, have 0"
# MenuItem.available auto-sets to false ✅
```

### 3️⃣ **Test: AI Chatbot (Rule-based)**

```bash
# Port 8001 (if running)

POST http://localhost:8001/chat
{
  "message": "Tôi muốn ăn phở",
  "session_id": "SESSION-001",
  "menu": [
    {"id": "menu1", "name": "Phở bò", "price": 50000, "tags": ["phở"], "available": true},
    {"id": "menu2", "name": "Cơm gà", "price": 35000, "tags": ["cơm"], "available": true},
    {"id": "menu3", "name": "Canh chua tôm", "price": 60000, "tags": ["canh"], "available": false}
  ]
}

# Response:
{
  "reply": "Gợi ý cho bạn:\n- Phở bò (50000₫)\n- Canh chua tôm (60000₫)",
  "suggestions": [
    {"menu_item_id": "menu1", "qty": 1},
    {"menu_item_id": "menu3", "qty": 1}
  ]
}

# Note: Only available=true items suggested
```

---

## Expected Database State

### After Test 1 (Receive Stock):
```sql
-- Check stock movements
SELECT id, type, qty, unit, created_at FROM stock_movements 
WHERE ingredient_id = 'GA001_UUID' ORDER BY created_at DESC;
-- Should see: 1 row type='NHẬP' qty=50

-- Check ingredient
SELECT id, name, min_stock FROM ingredients WHERE code='GA001';
-- Should see: name='Gạo trắng', min_stock=10
```

### After Test 2 (Auto-Deduct):
```sql
-- Check deductions
SELECT COUNT(*) FROM stock_movements 
WHERE ingredient_id = 'GA001_UUID' AND type = 'BÁN';
-- Should see: > 0 rows

-- Check menu item availability
SELECT id, name, available FROM menu_items WHERE id = 'MENU_ID';
-- If stock depleted: available=false

-- Check events
SELECT type, aggregate, aggregate_id FROM event_log 
WHERE type IN ('stock.consumed', 'stock.received', 'menu.soldout')
ORDER BY created_at DESC LIMIT 10;
-- Should see: stock.consumed, menu.soldout events
```

---

## Debugging

### API won't start?
```bash
# Check logs
tail -f C:\Users\PHONG\AppData\Local\Temp\claude\...\tasks\bwfrxf7dr.output

# Check database
docker ps | grep postgres
docker logs nha-hang-sen-postgres-1

# Compile manually
cd apps/api
pnpm typecheck
```

### Stock not deducted?
- Check: Recipe exists for menu item? ✅
- Check: Ingredient stock > 0? ✅
- Check: status transition PREPARING is happening? (log PATCH endpoint)
- Check: DeductStockForPreparation called? (add console.log if needed)

### AI not responding?
- Check: Port 8001 open? `netstat -an | grep 8001`
- Check: Menu items have `available: true`?
- Check: Request body has all fields?

---

## Git Commits to Reference

- `4c8ffe3` - TypeScript fixes (latest)
- `1651132` - Sprint 2: Auto-deduct
- `725bfd2` - Sprint 3: AI chatbot
- `ddfa882` - Sprint 1: Inventory foundation

---

## Next Steps (After Testing)

1. ✅ Verify auto-deduct works (most important)
2. ⏳ Test stock goes to 0 → dish locks
3. ⏳ Test insufficient stock error
4. ⏳ Hook API to AI service (`POST /ai/chat` endpoint)
5. ⏳ Tablet UI: add chat panel
6. ⏳ Sprint 4: Food cost reports

---

**Happy testing! 🎉**

Report any errors → I'll fix and restart API.
