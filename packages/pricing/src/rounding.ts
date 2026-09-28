/**
 * Làm tròn tại MỘT chỗ duy nhất (mục 13.3). Tiền luôn là số nguyên đồng.
 * Chia số nguyên rồi làm tròn nửa lên (xa số 0) để bút toán âm đối xứng với bút toán dương.
 */
export function divRound(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) {
    throw new RangeError(`Phép chia tiền không hợp lệ: ${numerator}/${denominator}`);
  }
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return sign * (r * 2 >= d ? q + 1 : q);
}

export function assertMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} phải là số nguyên đồng, nhận ${value}`);
}

/**
 * Phân bổ `amount` theo trọng số bằng phương pháp phần dư lớn nhất,
 * đảm bảo tổng các phần đúng bằng `amount`.
 */
export function allocate(amount: number, weights: number[]): number[] {
  assertMoney(amount, 'Số tiền phân bổ');
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => {
    const exact = amount * w;
    const base = Math.trunc(exact / total);
    return { base, rem: Math.abs(exact - base * total) };
  });
  let left = amount - raw.reduce((a, p) => a + p.base, 0);
  const step = Math.sign(left);
  const order = raw.map((p, i) => ({ i, rem: p.rem })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  const result = raw.map((p) => p.base);
  for (let k = 0; left !== 0; k = (k + 1) % order.length) {
    result[order[k].i] += step;
    left -= step;
  }
  return result;
}
