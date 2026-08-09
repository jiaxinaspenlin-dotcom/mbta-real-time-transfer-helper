import { bostonDateParts, mbtaFetch } from "./mbta-api";
import type { Network } from "./network";

export type Departure = {
  tripId: string | null;
  headsign: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  status: string | null;
  source: "prediction" | "schedule";
};

const PREDICTION_TTL = 15;
const SCHEDULE_TTL = 300;

function readDepartures(payload: any, source: Departure["source"]): Departure[] {
  const trips = new Map<string, any>(
    (payload?.included ?? []).filter((item: any) => item.type === "trip").map((item: any) => [item.id, item])
  );
  return (payload?.data ?? [])
    .map((item: any) => {
      const tripId = item.relationships?.trip?.data?.id ?? null;
      return {
        tripId,
        headsign: (tripId ? trips.get(tripId)?.attributes?.headsign : null) ?? item.attributes?.trip_headsign ?? null,
        departureTime: item.attributes?.departure_time ?? null,
        arrivalTime: item.attributes?.arrival_time ?? null,
        status: item.attributes?.status ?? null,
        source
      } as Departure;
    })
    .filter((item: Departure) => Boolean(item.departureTime));
}

/**
 * Real departures for one direction of one route. Live predictions first; when the
 * feed has none (late night, or a route between trips) fall back to the published
 * timetable. If neither exists we return nothing rather than inventing a time.
 */
export async function fetchDepartures(params: {
  stationId: string;
  routeId: string;
  directionId: number | null;
  afterIso: string;
  limit?: number;
}): Promise<Departure[]> {
  const { stationId, routeId, directionId, afterIso } = params;
  const limit = params.limit ?? 6;
  const after = new Date(afterIso).getTime();

  const predictionPayload = await mbtaFetch<any>(
    "/predictions",
    {
      "filter[stop]": stationId,
      "filter[route]": routeId,
      "filter[direction_id]": directionId ?? undefined,
      sort: "departure_time",
      "page[limit]": 20,
      include: "trip"
    },
    PREDICTION_TTL
  );

  const predictions = readDepartures(predictionPayload, "prediction").filter(
    (item) => new Date(item.departureTime!).getTime() >= after
  );
  if (predictions.length) return predictions.slice(0, limit);

  const { date, time } = bostonDateParts(afterIso);
  const schedulePayload = await mbtaFetch<any>(
    "/schedules",
    {
      "filter[stop]": stationId,
      "filter[route]": routeId,
      "filter[direction_id]": directionId ?? undefined,
      "filter[date]": date,
      "filter[min_time]": time,
      sort: "departure_time",
      "page[limit]": limit,
      include: "trip"
    },
    SCHEDULE_TTL
  );

  return readDepartures(schedulePayload, "schedule")
    .filter((item) => new Date(item.departureTime!).getTime() >= after)
    .slice(0, limit);
}

/**
 * When each of these specific trains reaches a specific station, read from the trips
 * themselves — never a per-stop average. A trip missing from the result simply does
 * not serve that station, which is how branch trains (Ashmont vs Braintree) are
 * ruled out. Batched into one request per stage to stay inside the API rate limit.
 */
export async function fetchTripArrivals(
  network: Network,
  tripIds: string[],
  stationId: string
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = Array.from(new Set(tripIds.filter(Boolean)));
  if (!unique.length) return found;

  const collect = (payload: any) => {
    for (const item of payload?.data ?? []) {
      const tripId = item.relationships?.trip?.data?.id;
      const stopId = item.relationships?.stop?.data?.id;
      if (!tripId || !stopId || found.has(tripId)) continue;
      const parent = network.platformToStation[stopId] ?? stopId;
      if (parent !== stationId) continue;
      const arrival = item.attributes?.arrival_time ?? item.attributes?.departure_time;
      if (arrival) found.set(tripId, arrival as string);
    }
  };

  collect(
    await mbtaFetch<any>(
      "/predictions",
      { "filter[trip]": unique.join(","), "filter[stop]": stationId },
      PREDICTION_TTL
    )
  );

  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    collect(
      await mbtaFetch<any>(
        "/schedules",
        { "filter[trip]": missing.join(","), "filter[stop]": stationId },
        SCHEDULE_TTL
      )
    );
  }

  return found;
}

export type ServiceAlert = {
  id: string;
  header: string;
  effect: string;
  severity: number;
  routeIds: string[];
  stationIds: string[];
  /** True when the alert covers a whole route rather than named stops. */
  wholeRoute: boolean;
};

const ALERT_TTL = 60;

/**
 * Active alerts touching the routes in this trip. Without these the app can score
 * a transfer "Likely" at a station that is closed or being shuttle-bussed.
 */
export async function fetchAlerts(network: Network, routeIds: string[]): Promise<ServiceAlert[]> {
  if (!routeIds.length) return [];
  const payload = await mbtaFetch<any>(
    "/alerts",
    { "filter[route]": Array.from(new Set(routeIds)).join(","), "filter[datetime]": "NOW" },
    ALERT_TTL
  );

  return (payload?.data ?? []).map((item: any) => {
    const entities: any[] = item.attributes?.informed_entity ?? [];
    const alertRoutes = new Set<string>();
    const stationIds = new Set<string>();
    let wholeRoute = false;

    for (const entity of entities) {
      if (entity.route) alertRoutes.add(entity.route);
      if (entity.stop) stationIds.add(network.platformToStation[entity.stop] ?? entity.stop);
      else if (entity.route) wholeRoute = true;
    }

    return {
      id: item.id,
      header: item.attributes?.header ?? "",
      effect: item.attributes?.effect ?? "UNKNOWN",
      severity: item.attributes?.severity ?? 0,
      routeIds: [...alertRoutes],
      stationIds: [...stationIds],
      wholeRoute
    } as ServiceAlert;
  });
}

export function formatClock(iso?: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function addMinutes(baseIso: string, minutes: number) {
  return new Date(new Date(baseIso).getTime() + minutes * 60000).toISOString();
}

export function scoreTransfer(params: { arrivalIso?: string | null; departureIso?: string | null; walkMinutes: number }) {
  if (!params.arrivalIso || !params.departureIso) return { label: null as string | null, seconds: null as number | null };
  const arrival = new Date(params.arrivalIso).getTime();
  const departure = new Date(params.departureIso).getTime();
  const margin = Math.floor((departure - arrival) / 1000 - params.walkMinutes * 60);
  if (margin >= 180) return { label: "Likely", seconds: margin };
  if (margin >= 0) return { label: "Risky", seconds: margin };
  return { label: "Unlikely", seconds: margin };
}

const CONFIDENCE_RANK: Record<string, number> = { Likely: 0, Risky: 1, Unlikely: 2 };

/** A trip is only as reliable as its tightest transfer. */
export function worstConfidence(labels: Array<string | null>) {
  const known = labels.filter((label): label is string => Boolean(label));
  if (!known.length) return null;
  return known.reduce((worst, label) => ((CONFIDENCE_RANK[label] ?? 0) > (CONFIDENCE_RANK[worst] ?? 0) ? label : worst));
}

export function formatMinutes(seconds: number | null) {
  if (seconds === null) return null;
  const sign = seconds >= 0 ? "+" : "−";
  const abs = Math.abs(seconds);
  return `${sign}${Math.floor(abs / 60)}m ${String(abs % 60).padStart(2, "0")}s`;
}

export function formatDuration(startIso?: string | null, endIso?: string | null) {
  if (!startIso || !endIso) return null;
  const minutes = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
