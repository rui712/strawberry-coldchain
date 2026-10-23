'use strict';

// Pure calculations shared by the interface and regression checks.
const ColdChainAnalysis = (() => {
  const valid = value => typeof value === 'number' && Number.isFinite(value);
  const state = (value, low, high) => !valid(value) ? 'missing' : value < low ? 'low' : value > high ? 'high' : 'normal';
  function stats(readings, key, low, high) {
    let outsideIntervals = 0, missingIntervals = 0;
    for (const row of readings.slice(0, -1)) {
      const kind = state(row.temperatures[key], low, high);
      if (kind === 'missing') missingIntervals++;
      if (kind === 'low' || kind === 'high') outsideIntervals++;
    }
    return { outsideIntervals, missingIntervals, validIntervals: Math.max(0, readings.length - 1) - missingIntervals };
  }
  function intervals(readings, key, low, high) {
    const result = [];
    let current = null;
    for (let i = 0; i < readings.length; i++) {
      const value = readings[i].temperatures[key];
      const kind = i === readings.length - 1 ? 'normal' : state(value, low, high);
      if (current && kind !== current.kind) {
        result.push({ ...current, end: i });
        current = null;
      }
      if (kind !== 'normal') {
        if (!current) current = { start: i, kind, min: null, max: null };
        if (valid(value)) {
          current.min = current.min === null ? value : Math.min(current.min, value);
          current.max = current.max === null ? value : Math.max(current.max, value);
        }
      }
    }
    return result;
  }
  return { valid, state, stats, intervals };
})();
if (typeof module !== 'undefined') module.exports = ColdChainAnalysis;
