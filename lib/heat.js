// Crime density surface from the official police-district totals.
//
// Each district's annual case count is spread around its HQ with a Gaussian whose width
// follows how close the neighbouring districts are: tight in KL, wide in rural Pahang.
// The result is cases per km² per year. Levels are national, so "red" means the same thing
// wherever you look: the densest areas that together hold 10% of Malaysia's cases are
// "very high", the next ones up to 25% "high", and so on. Ranking by share of cases rather
// than by share of land keeps cities from turning uniformly dark red.
//
// This is counts, not a per-capita rate, and it is an estimate smoothed from district
// totals. It cannot show which street or taman within a district is worse.
const { haversineKm } = require('./geo');

const MIN_SIGMA_KM = 1.5, MAX_SIGMA_KM = 12;
// share = fraction of national cases that falls in areas at or above this level.
const LEVELS = [
  { share: 0.75, label: 'Moderate', note: 'densest areas holding 75% of cases' },
  { share: 0.50, label: 'Elevated', note: 'densest areas holding 50% of cases' },
  { share: 0.25, label: 'High', note: 'densest areas holding 25% of cases' },
  { share: 0.10, label: 'Very high', note: 'densest areas holding 10% of cases' },
];

let model = null;

function build(districts) {
  const pts = districts.filter(d => d.total > 0).map(d => ({ lat: d.lat, lng: d.lng, total: d.total }));
  for (const p of pts) {
    const nn = Math.min(...pts.filter(o => o !== p).map(o => haversineKm(p, o)));
    p.sigma = Math.min(MAX_SIGMA_KM, Math.max(MIN_SIGMA_KM, 0.6 * nn));
    p.norm = p.total / (2 * Math.PI * p.sigma * p.sigma);
  }
  const density = (lat, lng) => {
    let v = 0;
    for (const p of pts) {
      // Cheap reject before the exact distance: 1° ≈ 111 km.
      if (Math.abs(p.lat - lat) * 111 > 4 * p.sigma || Math.abs(p.lng - lng) * 111 > 4 * p.sigma) continue;
      const r = haversineKm(p, { lat, lng });
      v += p.norm * Math.exp(-(r * r) / (2 * p.sigma * p.sigma));
    }
    return v;
  };

  // National reference sample: 2 km cells within 15 km of any HQ.
  const step = 2 / 111, seen = new Set(), sample = [];
  for (const p of pts) {
    for (let dy = -15; dy <= 15; dy += 2) for (let dx = -15; dx <= 15; dx += 2) {
      if (dx * dx + dy * dy > 225) continue;
      const lat = Math.round((p.lat + dy / 111) / step) * step;
      const lng = Math.round((p.lng + dx / (111 * Math.cos(p.lat * Math.PI / 180))) / step) * step;
      const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sample.push(density(lat, lng));
    }
  }
  // Densest cells first; each break is where the running total of cases reaches that share.
  sample.sort((a, b) => b - a);
  const total = sample.reduce((s, v) => s + v, 0);
  const breaks = LEVELS.map(l => {
    let run = 0;
    for (const v of sample) { run += v; if (run >= l.share * total) return v; }
    return sample[sample.length - 1];
  });
  return { density, breaks, cells: sample.length };
}

// Continuous level: 1–4 at each break, interpolated between them.
// Below the first break it returns 0–1 (v / break) so the overlay can fade in instead of starting at a hard edge.
function levelOf(v, breaks) {
  if (v < breaks[0]) return breaks[0] > 0 ? v / breaks[0] : 0;
  for (let i = breaks.length - 1; i >= 0; i--) {
    if (v >= breaks[i]) {
      if (i === breaks.length - 1) return breaks.length;
      return i + 1 + (v - breaks[i]) / (breaks[i + 1] - breaks[i]);
    }
  }
  return 0;
}

// A square grid of levels centred on a point, for the map overlay.
function getModel(districts) {
  if (!model || model.source !== districts) model = { ...build(districts), source: districts };
  return model;
}

// Density level (0–4, same scale as the overlay) at one point, for shading a route.
function levelAt(districts, lat, lng) {
  const m = getModel(districts);
  return levelOf(m.density(lat, lng), m.breaks);
}
const LEVEL_LABELS = ['Low', ...LEVELS.map(l => l.label)];

function grid(districts, center, { halfKm = 16, cellKm = 0.5 } = {}) {
  getModel(districts);
  const n = Math.round((2 * halfKm) / cellKm);
  const dLat = halfKm / 111, dLng = halfKm / (111 * Math.cos(center.lat * Math.PI / 180));
  const south = center.lat - dLat, north = center.lat + dLat, west = center.lng - dLng, east = center.lng + dLng;
  const levels = new Array(n * n);
  for (let row = 0; row < n; row++) {
    const lat = north - (row + 0.5) * (north - south) / n;
    for (let col = 0; col < n; col++) {
      const lng = west + (col + 0.5) * (east - west) / n;
      levels[row * n + col] = +levelOf(model.density(lat, lng), model.breaks).toFixed(2);
    }
  }
  const here = levelOf(model.density(center.lat, center.lng), model.breaks);
  return {
    bounds: [[south, west], [north, east]], size: n, levels,
    here: { level: +here.toFixed(2), label: here < 1 ? 'Low' : LEVELS[Math.floor(here) - 1].label,
      casesPerKm2: +model.density(center.lat, center.lng).toFixed(1) },
    legend: LEVELS.map((l, i) => ({ level: i + 1, label: l.label, note: l.note, minCasesPerKm2: +model.breaks[i].toFixed(1) })),
  };
}

module.exports = { grid, build, levelOf, levelAt, LEVEL_LABELS };
