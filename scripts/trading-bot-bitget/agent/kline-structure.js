'use strict';

function round(value, decimals = 8) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Number(value.toFixed(decimals));
}

function getSettings(granularity) {
  if (granularity === '1H') {
    return {
      pivotWindow: 2,
      tolerancePct: 0.006,
      breakoutPct: 0.002,
      minTouches: 3,
      recentBreakoutLookback: 8,
    };
  }

  return {
    pivotWindow: 2,
    tolerancePct: 0.004,
    breakoutPct: 0.002,
    minTouches: 3,
    recentBreakoutLookback: 8,
  };
}

function findPivotPoints(candles, kind, window) {
  const pivots = [];

  for (let index = window; index < candles.length - window; index++) {
    const current = kind === 'high' ? candles[index].high : candles[index].low;
    let isPivot = true;

    for (let offset = 1; offset <= window; offset++) {
      const before = kind === 'high' ? candles[index - offset].high : candles[index - offset].low;
      const after = kind === 'high' ? candles[index + offset].high : candles[index + offset].low;

      if (kind === 'high') {
        if (current < before || current < after) {
          isPivot = false;
          break;
        }
      } else if (current > before || current > after) {
        isPivot = false;
        break;
      }
    }

    if (isPivot) {
      pivots.push({
        index,
        time: candles[index].time,
        price: current,
      });
    }
  }

  return pivots;
}

function extractLevelPoints(candles, kind) {
  return candles.map((candle, index) => ({
    index,
    time: candle.time,
    price: kind === 'high' ? candle.high : candle.low,
  }));
}

function clusterPivots(pivots, tolerancePct) {
  const clusters = [];

  for (const pivot of pivots) {
    const existing = clusters.find((cluster) => Math.abs(pivot.price - cluster.price) <= cluster.price * tolerancePct);
    if (!existing) {
      clusters.push({
        price: pivot.price,
        touches: 1,
        firstIndex: pivot.index,
        lastIndex: pivot.index,
        members: [pivot],
      });
      continue;
    }

    existing.members.push(pivot);
    existing.touches += 1;
    existing.firstIndex = Math.min(existing.firstIndex, pivot.index);
    existing.lastIndex = Math.max(existing.lastIndex, pivot.index);
    existing.price = existing.members.reduce((sum, member) => sum + member.price, 0) / existing.members.length;
  }

  return clusters
    .map((cluster) => ({
      ...cluster,
      price: round(selectRepresentativePrice(cluster.members)),
    }))
    .sort((left, right) => left.price - right.price);
}

function selectRepresentativePrice(members) {
  const counts = new Map();

  for (const member of members) {
    const key = member.price.toFixed(8);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let bestKey = null;
  let bestCount = -1;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }

  return bestKey === null ? members[0]?.price ?? null : Number(bestKey);
}

function averageVolume(candles, endIndex, lookback = 20) {
  const start = Math.max(0, endIndex - lookback);
  const window = candles.slice(start, endIndex);
  if (window.length === 0) return 0;
  return window.reduce((sum, candle) => sum + candle.volumeUsdt, 0) / window.length;
}

function detectBreakout(candles, resistanceClusters, settings) {
  const startIndex = Math.max(settings.pivotWindow * 2, candles.length - settings.recentBreakoutLookback);

  for (let candleIndex = startIndex; candleIndex < candles.length; candleIndex++) {
    const candle = candles[candleIndex];
    const candidates = resistanceClusters
      .filter((cluster) => cluster.touches >= settings.minTouches && cluster.lastIndex < candleIndex)
      .sort((left, right) => right.price - left.price);

    for (const cluster of candidates) {
      const threshold = cluster.price * (1 + settings.breakoutPct);
      const recentPreBreakout = candles.slice(Math.max(0, candleIndex - 3), candleIndex);
      const wasStillBelow = recentPreBreakout.length === 0 || recentPreBreakout.every((item) => item.close <= threshold);
      const avgVol = averageVolume(candles, candleIndex);
      const hasVolume = avgVol === 0 || candle.volumeUsdt >= avgVol * 1.1;

      if (candle.close > threshold && wasStillBelow && hasVolume) {
        return {
          cluster,
          candleIndex,
          candle,
        };
      }
    }
  }

  return null;
}

function findNearestSupport(candles, pivotLows, ceilingPrice, breakoutIndex, baseStartIndex) {
  const baseRangeLows = pivotLows
    .filter((pivot) => pivot.index >= baseStartIndex && pivot.index < breakoutIndex && pivot.price < ceilingPrice)
    .sort((left, right) => left.price - right.price);

  if (baseRangeLows[0]) return round(baseRangeLows[0].price);

  const eligible = pivotLows
    .filter((pivot) => pivot.index < breakoutIndex && pivot.price < ceilingPrice)
    .sort((left, right) => left.price - right.price);

  return eligible[0] ? round(eligible[0].price) : null;
}

function detectRetest(candles, breakout, zone) {
  for (let index = breakout.candleIndex + 1; index < candles.length; index++) {
    const candle = candles[index];
    const touchedZone = candle.low <= zone.high && candle.low >= zone.low;
    const heldLevel = candle.close >= breakout.cluster.price;
    if (touchedZone && heldLevel) {
      return {
        confirmed: true,
        candleIndex: index,
        candleTime: candle.time,
      };
    }
  }

  return {
    confirmed: false,
    candleIndex: null,
    candleTime: null,
  };
}

function buildKlineStructureSummary(candles, granularity = '15m') {
  if (!Array.isArray(candles) || candles.length < 10) {
    return {
      resistanceLevel: null,
      supportLevel: null,
      pullbackZone: null,
      breakout: {
        detected: false,
        retestConfirmed: false,
        breakoutCandleTime: null,
        retestCandleTime: null,
      },
      latestStructureBias: 'neutral',
    };
  }

  const settings = getSettings(granularity);
  const pivotHighs = findPivotPoints(candles, 'high', settings.pivotWindow);
  const pivotLows = findPivotPoints(candles, 'low', settings.pivotWindow);
  const resistanceSeedPoints = pivotHighs.length >= settings.minTouches
    ? pivotHighs
    : extractLevelPoints(candles.slice(0, -1), 'high');
  const resistanceClusters = clusterPivots(resistanceSeedPoints, settings.tolerancePct);
  const breakout = detectBreakout(candles, resistanceClusters, settings);

  if (!breakout) {
    return {
      resistanceLevel: null,
      supportLevel: null,
      pullbackZone: null,
      breakout: {
        detected: false,
        retestConfirmed: false,
        breakoutCandleTime: null,
        retestCandleTime: null,
      },
      latestStructureBias: 'neutral',
    };
  }

  const zoneBuffer = breakout.cluster.price * settings.tolerancePct;
  const pullbackZone = {
    low: round(breakout.cluster.price - zoneBuffer, 2),
    high: round(breakout.cluster.price + zoneBuffer, 2),
  };
  const retest = detectRetest(candles, breakout, pullbackZone);
  const supportLevel = findNearestSupport(
    candles,
    pivotLows,
    breakout.cluster.price,
    breakout.candleIndex,
    breakout.cluster.firstIndex,
  );
  const latestClose = candles[candles.length - 1].close;

  return {
    resistanceLevel: round(breakout.cluster.price),
    supportLevel,
    pullbackZone,
    breakout: {
      detected: true,
      retestConfirmed: retest.confirmed,
      breakoutCandleTime: breakout.candle.time,
      retestCandleTime: retest.candleTime,
    },
    latestStructureBias: latestClose >= breakout.cluster.price ? 'bullish' : 'neutral',
  };
}

module.exports = {
  buildKlineStructureSummary,
};