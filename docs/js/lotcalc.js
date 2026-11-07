// Lot calculator data (SPEC 5.1, research r37): live-scale simulation, 0.03 lot on a 280 balance, 2025-01 .. 2026-10.
export const BASE_BALANCE = 280;
export const BASE_LOT = 0.03;

// 30-day horizon starting from 280: lot -> median, p10, p90 of the 30-day P&L and P(balance <= 140) in %.
export const HORIZON30 = [
  { lot: 0.03, median: 151.79, p10: -151.36, p90: 487.86, halfPct: 28.7 },
  { lot: 0.04, median: 135.40, p10: -229.53, p90: 663.16, halfPct: 40.2 },
  { lot: 0.05, median: 132.42, p10: -292.65, p90: 776.21, halfPct: 41.4 },
  { lot: 0.06, median: 90.37, p10: -299.85, p90: 899.49, halfPct: 50.6 },
  { lot: 0.08, median: 31.98, p10: -301.55, p90: 1012.44, halfPct: 60.9 },
];

// Daily P&L at 0.03 lot on 280.
export const DAILY_BASE = {
  losingDaysPct: 41,
  mean: -30.6, median: -26.2, p10: -56.4, p5: -65.3, worst: -96.9,
  overCapShare: 1 / 3, // 1 in 3 losing days exceeds the 10 % cap
};

const MIN_LOT = HORIZON30[0].lot, MAX_LOT = HORIZON30[HORIZON30.length - 1].lot;

export function interpolate(eqLot) {
  if (!(eqLot >= MIN_LOT - 1e-9 && eqLot <= MAX_LOT + 1e-9)) return null;
  for (let i = 0; i < HORIZON30.length - 1; i++) {
    const a = HORIZON30[i], b = HORIZON30[i + 1];
    if (eqLot <= b.lot + 1e-9) {
      const t = (eqLot - a.lot) / (b.lot - a.lot);
      const mix = (k) => a[k] + (b[k] - a[k]) * Math.max(0, Math.min(1, t));
      return { median: mix('median'), p10: mix('p10'), p90: mix('p90'), halfPct: mix('halfPct') };
    }
  }
  return { ...HORIZON30[HORIZON30.length - 1] };
}

// balance + lot -> scaled numbers. Scaling: equivalent lot at 280 = lot x 280 / balance; money x balance / 280.
export function calculate(balance, lot) {
  balance = Number(balance); lot = Number(lot);
  if (!(balance > 0) || !(lot > 0)) return null;
  const eqLot = (lot * BASE_BALANCE) / balance;
  const scale = balance / BASE_BALANCE;
  const row = interpolate(eqLot);
  const horizon = row && {
    median: row.median * scale, p10: row.p10 * scale, p90: row.p90 * scale, halfPct: row.halfPct,
    medianPct: (row.median / BASE_BALANCE) * 100, p10Pct: (row.p10 / BASE_BALANCE) * 100, p90Pct: (row.p90 / BASE_BALANCE) * 100,
  };
  // Daily numbers grow with the equivalent lot (linear in lot), then scale with the balance.
  const dScale = (eqLot / BASE_LOT) * scale;
  const d = DAILY_BASE;
  const daily = {
    losingDaysPct: d.losingDaysPct,
    mean: d.mean * dScale, median: d.median * dScale, p10: d.p10 * dScale, p5: d.p5 * dScale, worst: d.worst * dScale,
    pct: (x) => (x / balance) * 100,
    cap10: balance * 0.10,
  };
  return { balance, lot, eqLot, scale, inRange: !!row, horizon, daily };
}

// The whole table re-expressed for a balance: real lot that matches each tested row, money scaled.
export function tableForBalance(balance) {
  const scale = balance / BASE_BALANCE;
  return HORIZON30.map((r) => ({
    eqLot: r.lot, lot: r.lot * scale, median: r.median * scale, p10: r.p10 * scale, p90: r.p90 * scale, halfPct: r.halfPct,
  }));
}
