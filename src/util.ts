export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index] as T;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[… afgekapt, ${value.length - max} tekens weggelaten]`;
}

export function normalizeDate(raw: string | undefined, fallbackMs?: string | null): string {
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (fallbackMs) {
    const parsed = new Date(Number(fallbackMs));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return raw ?? "";
}
