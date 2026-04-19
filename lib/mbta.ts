import { LINE_LABELS, LineId, PlannedTrip, STATION_BY_ID } from "./network";

const ROUTE_IDS: Record<LineId, string> = {
  Red: "Red",
  Orange: "Orange",
  Blue: "Blue",
  "Green-E": "Green-E"
};

export type PredictionSnapshot = {
  departureTime: string | null;
  status: string | null;
};

export async function fetchUpcomingPredictions(stopId: string | undefined, line: LineId, limit = 4): Promise<PredictionSnapshot[]> {
  if (!stopId) return [];
  const key = process.env.MBTA_API_KEY;
  const url = new URL("https://api-v3.mbta.com/predictions");
  url.searchParams.set("filter[stop]", stopId);
  url.searchParams.set("filter[route]", ROUTE_IDS[line]);
  url.searchParams.set("sort", "departure_time");
  url.searchParams.set("page[limit]", String(limit));

  const res = await fetch(url.toString(), {
    headers: {
      accept: "application/vnd.api+json",
      ...(key ? { "x-api-key": key } : {})
    },
    next: { revalidate: 15 }
  }).catch(() => null);

  if (!res || !res.ok) return [];
  const json = (await res.json()) as any;
  return (json?.data ?? [])
    .map((item: any) => ({
      departureTime: item.attributes?.departure_time ?? item.attributes?.arrival_time ?? null,
      status: item.attributes?.status ?? null
    }))
    .filter((item: PredictionSnapshot) => Boolean(item.departureTime));
}

export async function fetchPrediction(stopId: string | undefined, line: LineId): Promise<PredictionSnapshot | null> {
  const items = await fetchUpcomingPredictions(stopId, line, 1);
  return items[0] ?? null;
}

export function formatClock(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function addMinutes(baseIso: string, minutes: number) {
  const d = new Date(baseIso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

export function scoreTransfer(params: { arrivalIso?: string | null; departureIso?: string | null; walkMinutes: number }) {
  if (!params.arrivalIso || !params.departureIso) return { label: "Scheduled", seconds: null as number | null };
  const arrival = new Date(params.arrivalIso).getTime();
  const departure = new Date(params.departureIso).getTime();
  const margin = Math.floor((departure - arrival) / 1000 - params.walkMinutes * 60);
  if (margin >= 180) return { label: "Likely", seconds: margin };
  if (margin >= 0) return { label: "Risky", seconds: margin };
  return { label: "Unlikely", seconds: margin };
}

export function formatMinutes(seconds: number | null) {
  if (seconds === null) return "—";
  const sign = seconds >= 0 ? "+" : "−";
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${m}m ${String(s).padStart(2, "0")}s`;
}

export function buildRouteGeometry(trip: PlannedTrip) {
  return trip.steps.filter((step) => step.kind === "ride" && step.line).map((step) => ({
    line: step.line!,
    points: step.stations.map((station) => [station.lat, station.lon] as [number, number])
  }));
}

export function buildMarkers(trip: PlannedTrip) {
  const markers: Array<{ kind: "board" | "transfer" | "arrive"; name: string; lat: number; lon: number }> = [];
  markers.push({ kind: "board", name: trip.origin.name, lat: trip.origin.lat, lon: trip.origin.lon });
  trip.steps.forEach((step, idx) => {
    if (step.kind === "transfer") {
      markers.push({ kind: "transfer", name: step.from.name, lat: step.from.lat, lon: step.from.lon });
    }
    if (idx === trip.steps.length - 1) {
      markers.push({ kind: "arrive", name: trip.destination.name, lat: trip.destination.lat, lon: trip.destination.lon });
    }
  });
  return markers;
}

export function tripSubtitle(trip: PlannedTrip) {
  return trip.steps.filter((s) => s.kind === "ride" && s.line).map((s) => `${LINE_LABELS[s.line!]} to ${s.to.name}`).join(" · ");
}

export function stationCandidatesFallback(query: string) {
  const q = query.toLowerCase();
  const presets = [
    { key: ["garden", "td"], id: "north-station", reason: "Closest MBTA station for TD Garden and nearby event traffic." },
    { key: ["common", "park"], id: "park-street", reason: "Park Street is the most direct station for Boston Common." },
    { key: ["logan", "airport"], id: "airport", reason: "Airport Station is the best MBTA connection for Logan access." },
    { key: ["northeastern", "museum of fine arts", "mfa"], id: "northeastern", reason: "Northeastern University station is the strongest Green Line E fit." },
    { key: ["state house", "government"], id: "government-center", reason: "Government Center is a strong Blue/Green transfer near downtown landmarks." }
  ];
  const matches = presets.filter((p) => p.key.some((token) => q.includes(token)));
  if (!matches.length) {
    return [
      { stationId: "park-street", stationName: STATION_BY_ID["park-street"].name, reason: "Central downtown transfer point for many Boston destinations." },
      { stationId: "north-station", stationName: STATION_BY_ID["north-station"].name, reason: "Good starting point for downtown venues and Green/Orange transfers." },
      { stationId: "government-center", stationName: STATION_BY_ID["government-center"].name, reason: "Strong option when the destination is near the Government Center / State House area." }
    ];
  }
  return matches.map((m) => ({ stationId: m.id, stationName: STATION_BY_ID[m.id].name, reason: m.reason }));
}
