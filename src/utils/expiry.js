'use strict';

/**
 * expiry.js — reading the partner key's expiry date, in whatever form it was
 * copied down.
 *
 * The date exists in exactly one place: the Shopee Open Platform console, which
 * prints it as `26/01/27 22:59 (UTC+07:00)`. Asking someone to retype that as
 * `2027-01-26` adds a step whose failure mode is silent — 26 January becomes
 * 1 February and nobody notices until the key lapses and every shop stops
 * syncing at once.
 *
 * So both forms are accepted, and the parsed result is always echoed back in
 * words ("26 Januari 2027") so a misreading is visible on screen instead of
 * discovered months later.
 */

/** `YYYY-MM-DD`, optionally followed by a time this ignores. */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The console's own format: `DD/MM/YY` or `DD/MM/YYYY`, with an optional time
 * and an optional `(UTC+07:00)` suffix.
 *
 * Read as day-first, which is what the console prints. Two-digit years are
 * 2000-based: this is an expiry date, so it is always in the near future.
 *
 * The four-digit year is tried first on purpose. The alternation is attempted
 * left to right and the pattern is not anchored at the end, so `\d{2}` would
 * happily match the "20" of "2027" and report the year 2020 — an expiry seven
 * years in the past, silently.
 */
const CONSOLE_FORMAT = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2}))?/;

const MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/** Zero-padded, because a Date built from a malformed string is silently NaN. */
const pad = (n) => String(n).padStart(2, '0');

/**
 * Parse the partner key expiry.
 *
 * @param {string} raw - As copied from the console, or as `YYYY-MM-DD`
 * @param {string} [utcOffset='+07:00'] - The business timezone
 * @returns {{ date: Date, label: string }|null} null when unreadable
 */
function parsePartnerKeyExpiry(raw, utcOffset = '+07:00') {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '') return null;

  let year;
  let month;
  let day;
  // End of day unless the source said otherwise: a key that lapses at 22:59 is
  // still usable for most of that day, and treating it as expired at midnight
  // would raise the alarm a day early every time.
  let hour = 23;
  let minute = 59;

  const iso = ISO_DAY.exec(value);
  const console_ = CONSOLE_FORMAT.exec(value);

  if (iso) {
    [, year, month, day] = iso.map(Number);
  } else if (console_) {
    day = Number(console_[1]);
    month = Number(console_[2]);
    const rawYear = console_[3];
    year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    if (console_[4] !== undefined) {
      hour = Number(console_[4]);
      minute = Number(console_[5]);
    }
  } else {
    return null;
  }

  // Rejected rather than rolled over: JavaScript happily turns month 13 into
  // January of the next year, which would report a comfortable margin on a date
  // that was mistyped.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const date = new Date(
    `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${utcOffset}`);
  if (Number.isNaN(date.getTime())) return null;

  // A date that survived the range check but not the calendar — 31 February,
  // say — rolls forward, so compare it back against what was asked for.
  const asked = `${year}-${pad(month)}-${pad(day)}`;
  const got = new Date(date.getTime() + tzOffsetMs(utcOffset)).toISOString().slice(0, 10);
  if (asked !== got) return null;

  return {
    date,
    label: `${day} ${MONTHS[month - 1]} ${year}`,
  };
}

/** `+07:00` → milliseconds, so a UTC instant can be read back as a local day. */
function tzOffsetMs(utcOffset) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * ((Number(match[2]) * 60 + Number(match[3])) * 60_000);
}

module.exports = { parsePartnerKeyExpiry };
