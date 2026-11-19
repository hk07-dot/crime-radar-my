// The data window: two calendar months back from today, where "today" is this computer's own
// date and time zone. 11 Nov → from 11 Sep. If the day doesn't exist two months back
// (31 Dec → 31 Oct is fine, 30 Apr → 30 Feb isn't), it falls back to that month's last day.
function windowStart(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(now.getDate(), lastDay));
  return d; // local midnight
}
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
module.exports = { windowStart, ymd };
