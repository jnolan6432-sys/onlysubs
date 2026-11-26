export function wallClockToDate(
  dateValue: string,
  timeValue: string,
  timeZone: string,
) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute, second = 0] = timeValue.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = desired;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(timestamp))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const difference = desired - represented;
    timestamp += difference;
    if (difference === 0) break;
  }

  return new Date(timestamp);
}

export function formatLeagueDate(
  dateValue: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) {
  const date = wallClockToDate(dateValue, "00:00", timeZone);
  return new Intl.DateTimeFormat("en", {
    ...options,
    timeZone,
  }).format(date);
}

export function formatLeagueTime(
  dateValue: string,
  timeValue: string,
  timeZone: string,
) {
  const date = wallClockToDate(dateValue, timeValue, timeZone);
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(date);
}

export function formatZonedDateTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(new Date(value));
}
