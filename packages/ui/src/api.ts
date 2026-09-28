export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { error?: string; message?: string | string[]; [k: string]: unknown } | null,
  ) {
    const m = body?.message;
    super(Array.isArray(m) ? m.join(', ') : (m ?? `Lỗi ${status}`));
  }
}

/** Lỗi mạng (không tới được server) — khác lỗi nghiệp vụ, client nên giữ nguyên dữ liệu để gửi lại. */
export class NetworkError extends Error {}

export const API_BASE = '/api';

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
}

export function createApi(getToken: () => string | null, onUnauthorized?: () => void): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = getToken();
    let res: Response;
    try {
      res = await fetch(API_BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NetworkError('Mất kết nối tới máy chủ');
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.status === 401) onUnauthorized?.();
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b, h) => request('POST', p, b ?? {}, h),
    patch: (p, b) => request('PATCH', p, b ?? {}),
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof NetworkError) return e.message;
  return 'Có lỗi xảy ra, vui lòng thử lại';
}
