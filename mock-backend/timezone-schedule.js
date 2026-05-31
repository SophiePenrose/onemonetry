export const UK_TIMEZONE = "Europe/London";

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getPart(parts, type) {
  return parts.find((part) => part.type === type)?.value || "";
}

function getZonedDateTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const weekdayToken = String(getPart(parts, "weekday") || "").slice(0, 3);

  return {
    year: Number.parseInt(getPart(parts, "year"), 10),
    month: Number.parseInt(getPart(parts, "month"), 10),
    day: Number.parseInt(getPart(parts, "day"), 10),
    hour: Number.parseInt(getPart(parts, "hour"), 10),
    minute: Number.parseInt(getPart(parts, "minute"), 10),
    second: Number.parseInt(getPart(parts, "second"), 10),
    weekday: Number.isInteger(WEEKDAY_INDEX[weekdayToken]) ? WEEKDAY_INDEX[weekdayToken] : 0,
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const utcEquivalent = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
  return utcEquivalent - date.getTime();
}

function zonedDateTimeToUtc(parts, timeZone) {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
    parts.millisecond || 0
  );

  const offset1 = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  let timestamp = utcGuess - offset1;

  // One correction pass handles DST boundaries.
  const offset2 = getTimeZoneOffsetMs(new Date(timestamp), timeZone);
  if (offset2 !== offset1) {
    timestamp = utcGuess - offset2;
  }

  return timestamp;
}

function addDaysUtcDate(year, month, day, daysToAdd) {
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function getNextWeeklyZonedRun(options = {}) {
  const timeZone = options.timeZone || UK_TIMEZONE;
  const targetWeekday = Number.isInteger(options.targetWeekday) ? options.targetWeekday : 6;
  const targetHour = Number.isInteger(options.hour) ? options.hour : 18;
  const targetMinute = Number.isInteger(options.minute) ? options.minute : 0;
  const targetSecond = Number.isInteger(options.second) ? options.second : 0;

  const fromDateRaw = options.fromDate instanceof Date ? options.fromDate : new Date(options.fromDate || Date.now());
  const fromDate = Number.isFinite(fromDateRaw.getTime()) ? fromDateRaw : new Date();

  const current = getZonedDateTimeParts(fromDate, timeZone);
  let daysUntilTarget = (targetWeekday - current.weekday + 7) % 7;

  const currentSeconds = (current.hour * 3600) + (current.minute * 60) + current.second;
  const targetSeconds = (targetHour * 3600) + (targetMinute * 60) + targetSecond;
  if (daysUntilTarget === 0 && currentSeconds >= targetSeconds) {
    daysUntilTarget = 7;
  }

  const targetDate = addDaysUtcDate(current.year, current.month, current.day, daysUntilTarget);
  const targetTimestamp = zonedDateTimeToUtc(
    {
      year: targetDate.year,
      month: targetDate.month,
      day: targetDate.day,
      hour: targetHour,
      minute: targetMinute,
      second: targetSecond,
      millisecond: 0,
    },
    timeZone
  );

  return new Date(targetTimestamp);
}
