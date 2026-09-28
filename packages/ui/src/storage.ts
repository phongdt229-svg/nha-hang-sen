/** localStorage có thể bị chặn (chế độ riêng tư, kiosk); luôn bọc try/catch. */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* bỏ qua */
    }
  },
};
