'use strict';

/**
 * Day boundaries for the date-picker filters.
 *
 * The UI sends a bare `YYYY-MM-DD`. Turning that into an instant needs a zone,
 * and the two obvious shortcuts are both wrong:
 *
 *   - `new Date('2026-08-22')` is parsed as UTC midnight, so a same-day range
 *     matches only orders created in that single instant.
 *   - `new Date('2026-08-22T00:00:00')` follows the *server's* zone. Nothing
 *     sets TZ in the Dockerfile or compose file, so a deployed container reads
 *     it as UTC and every "hari ini" silently becomes 07:00 WIB today through
 *     07:00 WIB tomorrow — the early-morning orders drop out of the count.
 *
 * The seller's own offset is used instead, so the numbers mean the same thing
 * wherever the app runs.
 */

const config = require('../config');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** `YYYY-MM-DDTHH:MM`, what a paired date + time input sends. */
const MINUTE_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

/**
 * @param {string} day - `YYYY-MM-DD`
 * @param {string} time - `HH:MM:SS.mmm`
 * @returns {Date|null} null when `day` is absent or not a bare date, so a
 *   malformed query parameter is ignored rather than becoming an Invalid Date
 *   that Prisma rejects with an unrelated-looking error.
 */
function boundary(day, time) {
  if (!day || !DAY_PATTERN.test(day)) return null;
  const at = new Date(`${day}T${time}${config.business.utcOffset}`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** First instant of `day` in the business timezone. */
function startOfDay(day) {
  const withMinute = MINUTE_PATTERN.exec(day || '');
  if (withMinute) return boundary(withMinute[1], `${withMinute[2]}:00.000`);
  return boundary(day, '00:00:00.000');
}

/**
 * Last instant of `day` in the business timezone.
 *
 * Given a time as well, that time is the exclusive edge: "sampai jam 15:00"
 * means the orders placed before 15:00, matching how Seller Centre labels its
 * own real-time window ("Hari Ini - Pk 15:00").
 */
function endOfDay(day) {
  const withMinute = MINUTE_PATTERN.exec(day || '');
  if (withMinute) {
    const at = boundary(withMinute[1], `${withMinute[2]}:00.000`);
    return at ? new Date(at.getTime() - 1) : null;
  }
  return boundary(day, '23:59:59.999');
}

/**
 * Prisma filter for an `orderDate` range, or null when neither bound is usable.
 *
 * @param {string} [dateFrom] - `YYYY-MM-DD`
 * @param {string} [dateTo] - `YYYY-MM-DD`
 * @returns {{gte?: Date, lte?: Date}|null}
 */
function orderDateRange(dateFrom, dateTo) {
  const gte = startOfDay(dateFrom);
  const lte = endOfDay(dateTo);
  if (!gte && !lte) return null;
  return {
    ...(gte ? { gte } : {}),
    ...(lte ? { lte } : {}),
  };
}

module.exports = { startOfDay, endOfDay, orderDateRange };
