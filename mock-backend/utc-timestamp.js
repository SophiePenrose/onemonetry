// SQLite datetime() values are UTC even when their text has no timezone.
// Keep explicit offsets intact; only repair the known legacy SQLite format.
export function sqliteUtcTimestamp(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    return `${text.replace(" ", "T")}Z`;
  }
  return text;
}
