// Tiny JSON-file store for incidents pulled from news and social media.
// Swap for Postgres + PostGIS once you go beyond a prototype.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'incidents.json');
const { windowStart } = require('./window');
// Keep a day of slack beyond the two-month window so a page opened just after midnight still has data.
const cutoff = () => windowStart().getTime() - 864e5;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function save(items) {
  const kept = items.filter(i => Date.parse(i.publishedAt) >= cutoff());
  fs.writeFileSync(FILE, JSON.stringify(kept, null, 1));
  return kept.length;
}

// Adds new incidents, de-duplicated by link.
function upsert(newItems) {
  const items = load();
  const seen = new Set(items.map(i => i.link));
  let added = 0;
  for (const it of newItems) if (!seen.has(it.link)) { items.push(it); seen.add(it.link); added++; }
  save(items);
  return added;
}

// Links already processed, so items that didn't become incidents aren't re-read every pull.
const SEEN_FILE = path.join(__dirname, '..', 'data', 'seen.json');
function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; }
}
function saveSeen(seen) {
  const kept = Object.fromEntries(Object.entries(seen).filter(([, t]) => t >= cutoff()));
  fs.writeFileSync(SEEN_FILE, JSON.stringify(kept));
}

// Rewrites the stored incidents (used when a new report is merged into an existing pin).
function replace(items) { save(items); }

// Items fetched but not yet processed (each run handles a limited number, so a backfill spreads over runs).
const QUEUE_FILE = path.join(__dirname, '..', 'data', 'queue.json');
function loadQueue() { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; } }
function saveQueue(items) {
  const kept = items.filter(i => !(Date.parse(i.publishedAt) < cutoff())).slice(0, 4000);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(kept));
}

module.exports = { load, upsert, replace, loadSeen, saveSeen, loadQueue, saveQueue, FILE };
