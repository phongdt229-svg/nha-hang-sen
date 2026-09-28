import type { ApiClient } from '@nhs/ui';
import { createContext, useContext } from 'react';

export interface PosContext {
  api: ApiClient;
  role: string;
  toast: (message: string, tone?: 'danger' | 'good') => void;
}

export const Pos = createContext<PosContext | null>(null);

export function usePos() {
  const ctx = useContext(Pos);
  if (!ctx) throw new Error('usePos ngoài Pos provider');
  return ctx;
}

export const STATION_LABEL: Record<string, string> = { BEP_NONG: 'Bếp nóng', BEP_LANH: 'Bếp lạnh', QUAY_BAR: 'Quầy bar' };
