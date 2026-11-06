// Sliders and saved settings use percent; only typing requests use probability.
// A global property keeps dependency repair safe without class redeclarations.
globalThis.PTTypoRate = Object.freeze({
  normalizePercent(value) {
    const number = typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? Number(value) : NaN;
    return Number.isFinite(number) && number >= 0 && number <= 50 ? number : 5;
  },
  toProbability(value) {
    return this.normalizePercent(value) / 100;
  },
  formatPercent(value) {
    return `${this.normalizePercent(value)}%`;
  }
});
