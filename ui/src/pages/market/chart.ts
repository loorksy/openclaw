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

const WIDTH = 640;
const HEIGHT = 220;
const PAD = 8;

/** Draw only the candles that were supplied. An empty read draws nothing. */
export function candleChart(
  candles: ChartCandle[],
): { width: number; height: number; bars: ChartBar[] } | null {
  if (candles.length === 0) {
    return null;
  }
  const min = Math.min(...candles.map((candle) => candle.low));
  const max = Math.max(...candles.map((candle) => candle.high));
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
  };
}
