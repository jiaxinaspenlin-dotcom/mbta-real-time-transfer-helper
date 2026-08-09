const BASE = "https://api-v3.mbta.com";

export class MbtaApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MbtaApiError";
  }
}

type Params = Record<string, string | number | undefined>;

/**
 * Every value this app shows a rider comes from the MBTA API. When a request
 * fails we throw rather than substitute a guess, so the UI can say so plainly.
 */
export async function mbtaFetch<T = any>(path: string, params: Params, revalidate: number): Promise<T> {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const apiKey = process.env.MBTA_API_KEY;
  const res = await fetch(url.toString(), {
    headers: {
      accept: "application/vnd.api+json",
      ...(apiKey ? { "x-api-key": apiKey } : {})
    },
    next: { revalidate }
  }).catch((cause) => {
    throw new MbtaApiError(`Could not reach the MBTA API (${String(cause)}).`);
  });

  if (res.status === 429) {
    throw new MbtaApiError(
      process.env.MBTA_API_KEY
        ? "The MBTA API is rate limiting this key. Wait a moment and try again."
        : "The MBTA API rate limit was hit. Add a free MBTA_API_KEY to .env.local to raise it."
    );
  }
  if (!res.ok) {
    throw new MbtaApiError(`MBTA API returned ${res.status} for ${path}.`);
  }
  return res.json() as Promise<T>;
}

/** MBTA schedule filters are expressed in Boston local time. */
export function bostonDateParts(iso: string) {
  const date = new Date(iso);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}
