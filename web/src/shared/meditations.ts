export interface Meditation {
  day_of_year: number;
  meditation: string;
  description: string;
  theme?: string;
  year?: number;
  year_day?: number;
}

function getDatePartsInTimeZone(date: Date, timeZone?: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);

  if (!year || !month || !day) {
    throw new Error('Could not resolve date parts for meditation lookup.');
  }

  return {year, month, day};
}

export function getDayOfYearForDate(date: Date, options?: {timeZone?: string}): number {
  const {year, month, day} = getDatePartsInTimeZone(date, options?.timeZone);
  const utcTarget = Date.UTC(year, month - 1, day);
  const utcStart = Date.UTC(year, 0, 1);
  return Math.floor((utcTarget - utcStart) / 86400000) + 1;
}

export function getMeditationForDate(
  meditations: Meditation[],
  date: Date,
  options?: {timeZone?: string},
): Meditation | null {
  if (!meditations.length) return null;

  const dayOfYear = getDayOfYearForDate(date, options);
  const exact = meditations.find((entry) => entry.day_of_year === dayOfYear);
  if (exact) {
    return exact;
  }

  const normalized = ((dayOfYear - 1) % meditations.length + meditations.length) % meditations.length;
  return meditations[normalized] || null;
}
