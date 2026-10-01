// Sync manager: queue orders offline, sync when online

import type { QueuedOrder } from './indexeddb';
import { addToQueue, getQueue, initDB, removeFromQueue, updateQueueStatus } from './indexeddb';

export interface SyncManager {
  isOnline: boolean;
  queueOrder(order: QueuedOrder): Promise<void>;
  syncQueue(api: (method: string, path: string, body: any) => Promise<any>): Promise<{ synced: number; failed: number }>;
}

let manager: SyncManager | null = null;

export function createSyncManager(): SyncManager {
  if (manager) return manager;

  let isOnline = navigator.onLine;

  manager = {
    isOnline,

    async queueOrder(order: QueuedOrder) {
      await initDB();
      await addToQueue(order);
    },

    async syncQueue(api: (method: string, path: string, body: any) => Promise<any>) {
      const queue = await getQueue();
      const pending = queue.filter((q) => q.status === 'pending');

      let synced = 0;
      let failed = 0;

      for (const order of pending) {
        try {
          // Attempt to sync to API
          await api('POST', `/sessions/${order.sessionId}/orders`, {
            items: order.items,
            idempotencyKey: order.idempotencyKey,
          });

          await updateQueueStatus(order.id, 'synced');
          synced++;
        } catch (e: any) {
          const errorMsg = e?.message || 'Unknown error';
          await updateQueueStatus(order.id, 'failed', errorMsg);
          failed++;
        }
      }

      // Clean up synced orders
      const updated = await getQueue();
      for (const order of updated) {
        if (order.status === 'synced') {
          await removeFromQueue(order.id);
        }
      }

      return { synced, failed };
    },
  };

  // Listen for online/offline events
  window.addEventListener('online', () => {
    manager!.isOnline = true;
    console.log('📡 Back online — attempting to sync queue');
    // App should call syncQueue() when detecting online
  });

  window.addEventListener('offline', () => {
    manager!.isOnline = false;
    console.log('⚠️ Offline — orders will be queued');
  });

  return manager;
}

export function getSyncManager(): SyncManager {
  return manager || createSyncManager();
}
