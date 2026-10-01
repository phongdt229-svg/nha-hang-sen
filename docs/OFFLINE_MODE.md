# Offline Mode (PWA)

Tablet gọi món hoạt động khi mất Internet. Orders được lưu locally, sync tự động khi có mạng.

## Architecture

```
┌─────────────────────────────────────────┐
│ Tablet App (React)                      │
│ ┌─────────────────────────────────────┐ │
│ │ useOnlineStatus() hook              │ │
│ │ - Detect navigator.onLine           │ │
│ │ - Show "Offline" badge              │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
           │ order (offline?)
           ↓
┌─────────────────────────────────────────┐
│ SyncManager (apps/ui/src/offline/sync)  │
│ - Queue orders locally if offline       │
│ - Retry on reconnect                    │
└─────────────────────────────────────────┘
           │
           ↓
┌─────────────────────────────────────────┐
│ IndexedDB (apps/ui/src/offline/indexeddb)
│ - Store order-queue table               │
│ - Persist across page reload            │
└─────────────────────────────────────────┘
           │
           ↓
┌─────────────────────────────────────────┐
│ Service Worker (apps/tablet/public/sw)  │
│ - Cache menu, tables (network-first)    │
│ - Cache static assets (cache-first)     │
└─────────────────────────────────────────┘
```

## Integration

### 1. Register Service Worker

In Tablet app initialization:

```typescript
// apps/tablet/src/main.tsx
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/tablet/sw.js').catch(console.error);
}
```

### 2. Detect Online Status

```typescript
import { useEffect, useState } from 'react';
import { getSyncManager } from '@nhs/ui/offline/sync';

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const sync = getSyncManager();

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void sync.syncQueue(api); // Trigger sync on reconnect
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [sync]);

  return isOnline;
}
```

### 3. Queue Orders When Offline

```typescript
async function submitOrder(items, sessionId) {
  const sync = getSyncManager();
  
  if (!sync.isOnline) {
    // Queue locally
    await sync.queueOrder({
      id: crypto.randomUUID(),
      sessionId,
      idempotencyKey: generateKey(),
      items,
      createdAt: Date.now(),
      status: 'pending',
    });
    toast('Lưu tạm — sẽ gửi khi có mạng');
    return;
  }

  // Send to API normally
  await api.post(`/sessions/${sessionId}/orders`, { items });
}
```

## Features

- ✅ **Cache menu & tables** (SW cache-first)
- ✅ **Queue orders offline** (IndexedDB)
- ✅ **Auto-sync on reconnect** (window.online event)
- ✅ **Idempotency** (orders won't duplicate via idempotency_key)
- ✅ **Persist across reload** (IndexedDB survives page refresh)

## Limitations

- ❌ Cannot pay offline (payment requires API)
- ❌ Cannot see live kitchen status offline
- ❌ Cannot access reports offline
- ✅ Can browse menu, add to cart, submit orders

## Testing

1. Open DevTools → Application → Service Workers → Offline checkbox
2. Add items to cart
3. Submit order → should queue locally
4. Check DevTools → Application → IndexedDB → nhs-offline → order-queue
5. Uncheck Offline → order syncs automatically

## Production Deploy

- Service Worker cached by browser (long TTL)
- IndexedDB survives app updates (auto-versioned)
- Manifest.json required for PWA install
- HTTPS required (SW only works on secure context)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Orders not syncing | Check DevTools → Application → Service Workers (registered?) |
| Menu not cached | Check `STATIC_URLS` in sw.js includes `/menu` |
| IndexedDB quota exceeded | Clear old queued orders, increase quota per domain |
| PWA not installable | Check manifest.json, icons, HTTPS |

