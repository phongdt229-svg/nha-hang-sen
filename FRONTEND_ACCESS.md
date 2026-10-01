# Frontend Applications - Access Guide

## ✅ All Running!

| App | Port | URL | Role | Purpose |
|---|---|---|---|---|
| **Tablet** | 5173 | http://localhost:5173 | Customer/Guest | 🍽️ Order food, add to cart |
| **POS** | 5174 | http://localhost:5174 | Cashier | 💳 Process payments, bill splitting, close shift |
| **KDS** | 5175 | http://localhost:5175 | Kitchen | 👨‍🍳 Receive orders, update status (Preparing/Ready) |

---

## 🔐 Login Credentials

Use for all 3 apps (API handles role-based access):

```
Username: phucvu        (Waiter/Staff)
Password: sen123

Other users:
- admin      / sen123   (Admin)
- quanly     / sen123   (Manager)  
- thungan    / sen123   (Cashier)
- bep        / sen123   (Kitchen)
- ketoan     / sen123   (Accountant)
```

---

## 🎬 Test Flow

### Step 1: Tablet (Customer Orders)
1. Open http://localhost:5173
2. Login as **phucvu** (waiter/staff)
3. Click on a table (T01, T02, etc.)
4. Browse menu → Add dishes
5. Click "Confirm Order" (Xác nhận gọi món)
6. **Note the order number** (e.g., #001)

### Step 2: KDS (Kitchen Display)
1. Open http://localhost:5175
2. Login as **bep** (kitchen staff)
3. **You'll see the order** from Step 1 on screen
4. Click "ACK" (Nhận) to confirm you got it
5. Update status → "Preparing" (Đang nấu)
   - **🔥 AUTO-DEDUCT STOCK HAPPENS HERE!**
   - Check: `GET http://localhost:8000/stock/levels` → qty reduced ✅
6. Update status → "Ready" (Xong) when done

### Step 3: POS (Cashier Billing)
1. Open http://localhost:5174
2. Login as **thungan** (cashier)
3. Find the order/table from Step 1
4. Generate bill (Tính tiền)
5. Process payment (Thanh toán)
   - QR code / Card / Cash
6. Close bill (Đóng phiếu)

---

## 🧪 Phase 2 Test: Auto-Deduct Stock

### Preconditions (via API or direct SQL):
1. Create ingredient: `GA001` (Rice, kg)
2. Receive stock: 100 kg at 20,000₫/kg
3. Set recipe for menu item: 0.5 kg/portion (5% waste)

### Execution:
| Step | App | Action | Expected Result |
|---|---|---|---|
| 1 | Tablet | Order 2 portions | Order #001 created |
| 2 | KDS | ACK + Preparing | Stock deducts: 2 × 0.5 × 1.05 = 1.05 kg |
| 3 | API | GET /stock/levels | currentStock: 98.95 kg ✅ |
| 4 | Tablet | Order 95 more times | After 95 more orders: 0 kg left |
| 5 | Tablet | Try order again | Menu item locked (available=false) ❌ |
| 6 | Database | Check event_log | See `stock.consumed`, `menu.soldout` events |

---

## 📊 API Integration Points

### Tablet calls:
```
POST /sessions              → Create dining session
GET /menu                   → Fetch available dishes
POST /sessions/:id/orders   → Confirm order (idempotency key)
WebSocket /table/:id        → Real-time updates
```

### KDS calls:
```
GET /kitchen/tickets        → Get tickets for station
POST /kitchen/tickets/:id/ack → ACK the order
PATCH /order-items/:id/status → Update Preparing/Ready
WebSocket /kitchen/:station → Real-time ticket updates
```

### POS calls:
```
GET /sessions/:id/bill      → Get bill
POST /bills/:id/lock        → Lock bill
POST /bills/:id/payments    → Create payment
WebSocket /pos              → Real-time bill updates
```

---

## 🐛 Debugging

### Tablet won't load?
```bash
# Check Vite server
lsof -i :5173
# or check logs:
tail -f C:\Users\PHONG\AppData\Local\Temp\claude\...\bsvh7onyd.output
```

### Can't login?
- API running on 8000? `curl http://localhost:8000/health`
- Database up? `docker ps | grep postgres`
- Seed data? Check users table: `SELECT * FROM users LIMIT 5;`

### Orders not appearing on KDS?
- WebSocket connected? Check browser DevTools → Network
- API emitting events? Check `event_log` table
- KDS filter by station? Some dishes are assigned to specific stations

### Stock not deducting?
1. Check recipe exists: `GET http://localhost:8000/menu/MENU_ID/recipe`
2. Check ingredient stock: `GET http://localhost:8000/stock/levels`
3. Update status to PREPARING - does it fail?
4. Check `stock_movements` table for BÁN type entries

---

## 📱 Device Simulation

For better UX, open apps on different screen sizes:

### Tablet view (iPad, 800x600)
```
Shift+F12 → Ctrl+Shift+M → Select iPad
```

### POS view (Desktop, 1024x768)
```
Full screen or browser default
```

### KDS view (Portrait, 480x800)
```
Shift+F12 → Ctrl+Shift+M → Select Portrait mode
```

---

## 🚀 Next Tests

1. ✅ Order → Deduct stock → Dish locks
2. ⏳ Split bill (multiple customers)
3. ⏳ Payment methods (QR, card, cash)
4. ⏳ Discard order (should NOT deduct stock if before PREPARING)
5. ⏳ AI chatbot in Tablet (when integrated)

---

**Ghi chú:** API, Database, MQTT đã sẵn sàng ✅ Frontend đang chạy ✅

**Let's test! 🎉**
