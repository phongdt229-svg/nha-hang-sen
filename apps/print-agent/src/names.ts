const NAMES: Record<string, string> = {
  BEP_NONG: 'Máy in bếp nóng',
  BEP_LANH: 'Máy in bếp lạnh',
  QUAY_BAR: 'Máy in quầy bar',
  RECEIPT: 'Máy in quầy thu ngân',
};

export const targetName = (target: string) => NAMES[target] ?? `Máy in ${target}`;
