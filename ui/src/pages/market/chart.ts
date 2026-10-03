export type ChartCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type ChartBar = {
  x: number;
  highY: number;
  lowY: number;
  bodyY: number;
  bodyHeight: number;
  width: number;
  up: boolean;
};

export type ChartLineKind = "prior-high" | "prior-low" | "buy-side" | "sell-side" | "break";

export type ChartMark =
  | { kind: ChartLineKind; price: number }
  | { kind: "demand" | "supply"; low: number; high: number };

export type ChartLine = { kind: ChartLineKind; y: number };

export type ChartBand = { kind: "demand" | "supply"; y: number; height: number };

const WIDTH = 640;
const HEIGHT = 220;
const PAD = 8;

/**
 * Draw the supplied closed candles. Known levels widen the scale and are drawn
 * with them. An empty candle read draws nothing, even if levels were supplied.
 */
export function candleChart(
  candles: ChartCandle[],
  marks: readonly ChartMark[] = [],
): {
  width: number;
  height: number;
  bars: ChartBar[];
  lines: ChartLine[];
  bands: ChartBand[];
} | null {
  if (candles.length === 0) {
    return null;
  }
  const lines: { kind: ChartLineKind; price: number }[] = [];
  const bands: { kind: "demand" | "supply"; low: number; high: number }[] = [];
  for (const mark of marks) {
    if (mark.kind === "demand" || mark.kind === "supply") {
      if (mark.high > mark.low && mark.low > 0 && Number.isFinite(mark.high)) {
        bands.push({ kind: mark.kind, low: mark.low, high: mark.high });
      }
      continue;
    }
    if (Number.isFinite(mark.price) && mark.price > 0) {
      lines.push({ kind: mark.kind, price: mark.price });
    }
  }
  const prices = [
    ...candles.flatMap((candle) => [candle.low, candle.high]),
    ...lines.map((line) => line.price),
    ...bands.flatMap((band) => [band.low, band.high]),
  ];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (![min, max].every(Number.isFinite)) {
    return null;
  }
  const span = max === min ? Math.max(max * 0.001, 0.01) : max - min;
  const slot = (WIDTH - PAD * 2) / candles.length;
  const bodyWidth = Math.max(1, slot * 0.62);
  const yFor = (price: number) => PAD + ((max - price) / span) * (HEIGHT - PAD * 2);
  return {
    width: WIDTH,
    height: HEIGHT,
    bars: candles.map((candle, index) => {
      const openY = yFor(candle.open);
      const closeY = yFor(candle.close);
      return {
        x: PAD + index * slot + (slot - bodyWidth) / 2,
        highY: yFor(candle.high),
        lowY: yFor(candle.low),
        bodyY: Math.min(openY, closeY),
        bodyHeight: Math.max(1, Math.abs(closeY - openY)),
        width: bodyWidth,
        up: candle.close >= candle.open,
      };
    }),
    lines: lines.map((line) => ({ kind: line.kind, y: yFor(line.price) })),
    bands: bands.map((band) => {
      const top = yFor(band.high);
      const bottom = yFor(band.low);
      return { kind: band.kind, y: top, height: Math.max(1, bottom - top) };
    }),
  };
}
