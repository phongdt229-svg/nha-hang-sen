// IndexedDB store for offline order sync queue

const DB_NAME = 'nhs-offline';
const DB_VERSION = 1;
const QUEUE_STORE = 'order-queue';

export interface QueuedOrder {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  items: { menuItemId: string; qty: number; note?: string }[];
  createdAt: number;
  status: 'pending' | 'synced' | 'failed';
  errorMsg?: string;
}

let db: IDBDatabase | null = null;

export async function initDB(): Promise<IDBDatabase> {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };

    req.onupgradeneeded = (e) => {
      const database = (e.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        database.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      }
    };
  });
}

export async function addToQueue(order: QueuedOrder): Promise<void> {
  const database = await initDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([QUEUE_STORE], 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.add(order);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export async function getQueue(): Promise<QueuedOrder[]> {
  const database = await initDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([QUEUE_STORE], 'readonly');
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || []);
  });
}

export async function updateQueueStatus(id: string, status: 'pending' | 'synced' | 'failed', errorMsg?: string): Promise<void> {
  const database = await initDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([QUEUE_STORE], 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.get(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      if (req.result) {
        req.result.status = status;
        if (errorMsg) req.result.errorMsg = errorMsg;
        const updateReq = store.put(req.result);
        updateReq.onerror = () => reject(updateReq.error);
        updateReq.onsuccess = () => resolve();
      }
    };
  });
}

export async function removeFromQueue(id: string): Promise<void> {
  const database = await initDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([QUEUE_STORE], 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.delete(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export async function clearQueue(): Promise<void> {
  const database = await initDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([QUEUE_STORE], 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.clear();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}
