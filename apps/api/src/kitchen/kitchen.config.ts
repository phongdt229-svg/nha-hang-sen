export const KITCHEN_QUEUE = 'kitchen';

export const kitchenConfig = () => ({
  ackTimeoutMs: Number(process.env.KDS_ACK_TIMEOUT_MS ?? 3000),
  maxRetry: Number(process.env.KDS_MAX_RETRY ?? 3),
});

/** Giãn cách tăng dần: 3s, 6s, 12s… sau lần gửi thứ `attempt`. */
export const retryDelay = (attempt: number) => kitchenConfig().ackTimeoutMs * 2 ** (attempt - 1);
