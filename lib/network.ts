import { MbtaApiError, mbtaFetch } from "./mbta-api";

export type LineRoute = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  textColor: string;
  sortOrder: number;
};

export type Station = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  routeIds: string[];
};

export type Pattern = {
  id: string;
  routeId: string;
  directionId: number;
  name: string;
  stationIds: string[];
};

export type Network = {
  routes: LineRoute[];
  routeById: Record<string, LineRoute>;
  stations: Station[];
  stationById: Record<string, Station>;
  patterns: Pattern[];
  /** Platform-level stop id -> parent station id, for reading prediction payloads. */
  platformToStation: Record<string, string>;
  adjacency: Map<string, Array<{ to: string; routeId: string }>>;
};

const NETWORK_TTL_MS = 12 * 60 * 60 * 1000;
let cached: { at: number; network: Network } | null = null;

/** Strip the redundant "Line" suffix so pills stay short; keep whatever the API gives otherwise. */
function shortenRouteName(longName: string) {
  return longName.replace(/\s+Line\b/, "").trim() || longName;
}

async function buildNetwork(): Promise<Network> {
  const routeResponse = await mbtaFetch<any>("/routes", { "filter[type]": "0,1", sort: "sort_order" }, 86400);
  const routes: LineRoute[] = (routeResponse?.data ?? []).map((item: any) => ({
    id: item.id,
    name: item.attributes?.long_name ?? item.id,
    shortName: shortenRouteName(item.attributes?.long_name ?? item.id),
    color: `#${item.attributes?.color ?? "6B7280"}`,
    textColor: `#${item.attributes?.text_color ?? "FFFFFF"}`,
    sortOrder: item.attributes?.sort_order ?? 0
  }));

  if (!routes.length) {
    throw new MbtaApiError("The MBTA API returned no subway routes.");
  }

  const patternResponse = await mbtaFetch<any>(
    "/route_patterns",
    {
      "filter[route]": routes.map((r) => r.id).join(","),
      "filter[canonical]": "true",
      include: "representative_trip.stops"
    },
    86400
  );

  const included = new Map<string, any>((patternResponse?.included ?? []).map((item: any) => [`${item.type}:${item.id}`, item]));

  const stationById: Record<string, Station> = {};
  const platformToStation: Record<string, string> = {};
  const patterns: Pattern[] = [];

  for (const item of patternResponse?.data ?? []) {
    const tripRef = item.relationships?.representative_trip?.data;
    if (!tripRef) continue;
    const trip = included.get(`trip:${tripRef.id}`);
    const stopRefs = trip?.relationships?.stops?.data ?? [];

    const stationIds: string[] = [];
    for (const stopRef of stopRefs) {
      const stop = included.get(`stop:${stopRef.id}`);
      if (!stop) continue;
      const parentId = stop.relationships?.parent_station?.data?.id ?? stop.id;
      const attributes = stop.attributes ?? {};
      if (attributes.latitude == null || attributes.longitude == null) continue;

      platformToStation[stop.id] = parentId;
      if (!stationById[parentId]) {
        stationById[parentId] = {
          id: parentId,
          name: attributes.name,
          lat: attributes.latitude,
          lon: attributes.longitude,
          routeIds: []
        };
      }
      const station = stationById[parentId];
      if (!station.routeIds.includes(item.relationships.route.data.id)) {
        station.routeIds.push(item.relationships.route.data.id);
      }
      // A pattern can list several platforms of the same station in a row.
      if (stationIds[stationIds.length - 1] !== parentId) stationIds.push(parentId);
    }

    if (stationIds.length < 2) continue;
    patterns.push({
      id: item.id,
      routeId: item.relationships.route.data.id,
      directionId: item.attributes?.direction_id ?? 0,
      name: item.attributes?.name ?? item.id,
      stationIds
    });
  }

  if (!patterns.length) {
    throw new MbtaApiError("The MBTA API returned no canonical route patterns.");
  }

  const adjacency = new Map<string, Array<{ to: string; routeId: string }>>();
  const link = (from: string, to: string, routeId: string) => {
    const edges = adjacency.get(from) ?? [];
    if (!edges.some((edge) => edge.to === to && edge.routeId === routeId)) edges.push({ to, routeId });
    adjacency.set(from, edges);
  };
  for (const pattern of patterns) {
    for (let i = 0; i < pattern.stationIds.length - 1; i += 1) {
      link(pattern.stationIds[i], pattern.stationIds[i + 1], pattern.routeId);
      link(pattern.stationIds[i + 1], pattern.stationIds[i], pattern.routeId);
    }
  }

  const usedRouteIds = new Set(patterns.map((p) => p.routeId));
  const activeRoutes = routes.filter((route) => usedRouteIds.has(route.id));

  return {
    routes: activeRoutes,
    routeById: Object.fromEntries(activeRoutes.map((route) => [route.id, route])),
    stations: Object.values(stationById).sort((a, b) => a.name.localeCompare(b.name)),
    stationById,
    patterns,
    platformToStation,
    adjacency
  };
}

export async function loadNetwork(): Promise<Network> {
  if (cached && Date.now() - cached.at < NETWORK_TTL_MS) return cached.network;
  const network = await buildNetwork();
  cached = { at: Date.now(), network };
  return network;
}

/** Line shapes for the map, drawn from the canonical outbound pattern of every branch. */
export function networkGeometry(network: Network) {
  return network.patterns
    .filter((pattern) => pattern.directionId === 0)
    .map((pattern) => ({
      id: pattern.id,
      routeId: pattern.routeId,
      points: pattern.stationIds.map((id) => {
        const station = network.stationById[id];
        return [station.lat, station.lon] as [number, number];
      })
    }));
}

export type Ride = {
  routeId: string;
  directionId: number | null;
  from: Station;
  to: Station;
  stations: Station[];
};

export type TripStep =
  | { kind: "ride"; ride: Ride }
  | { kind: "transfer"; station: Station; fromRouteId: string; toRouteId: string };

export type PlannedTrip = {
  origin: Station;
  destination: Station;
  rides: Ride[];
  steps: TripStep[];
};

/**
 * Parts of the network that are out of service. `routeStops` is keyed by
 * `routeId|stationId` because a suspension usually covers a segment of one line,
 * not the whole line, and certainly not the station for every other line there.
 */
export type Avoid = {
  routes: Set<string>;
  stations: Set<string>;
  routeStops: Set<string>;
};

export function emptyAvoid(): Avoid {
  return { routes: new Set(), stations: new Set(), routeStops: new Set() };
}

function edgeBlocked(avoid: Avoid | undefined, routeId: string, from: string, to: string) {
  if (!avoid) return false;
  if (avoid.routes.has(routeId)) return true;
  if (avoid.stations.has(from) || avoid.stations.has(to)) return true;
  return avoid.routeStops.has(`${routeId}|${from}`) || avoid.routeStops.has(`${routeId}|${to}`);
}

/** Whether a planned trip touches anything currently out of service. */
export function tripUsesBlocked(trip: PlannedTrip, avoid: Avoid) {
  return trip.rides.some((ride) => {
    if (avoid.routes.has(ride.routeId)) return true;
    return ride.stations.some(
      (station) => avoid.stations.has(station.id) || avoid.routeStops.has(`${ride.routeId}|${station.id}`)
    );
  });
}

const TRANSFER_PENALTY = 1000;

/** Least-transfers-then-fewest-stops search over the live network graph. */
function searchPath(network: Network, originId: string, destinationId: string, avoid?: Avoid) {
  type State = { station: string; routeId: string };
  const keyOf = (s: State) => `${s.station}|${s.routeId}`;

  const dist = new Map<string, number>();
  const prev = new Map<string, { key: string; state: State } | null>();
  const states = new Map<string, State>();

  const startEdges = (network.adjacency.get(originId) ?? []).filter(
    (edge) => !edgeBlocked(avoid, edge.routeId, originId, edge.to)
  );
  for (const edge of startEdges) {
    const state = { station: originId, routeId: edge.routeId };
    const key = keyOf(state);
    if (!dist.has(key)) {
      dist.set(key, 0);
      prev.set(key, null);
      states.set(key, state);
    }
  }

  const visited = new Set<string>();
  let bestFinalKey: string | null = null;

  while (true) {
    let currentKey: string | null = null;
    let currentCost = Infinity;
    for (const [key, cost] of dist) {
      if (!visited.has(key) && cost < currentCost) {
        currentCost = cost;
        currentKey = key;
      }
    }
    if (!currentKey) break;
    visited.add(currentKey);

    const state = states.get(currentKey)!;
    if (state.station === destinationId) {
      bestFinalKey = currentKey;
      break;
    }

    for (const edge of network.adjacency.get(state.station) ?? []) {
      if (edgeBlocked(avoid, edge.routeId, state.station, edge.to)) continue;
      const next: State = { station: edge.to, routeId: edge.routeId };
      const nextKey = keyOf(next);
      const cost = currentCost + 1 + (edge.routeId === state.routeId ? 0 : TRANSFER_PENALTY);
      if (cost < (dist.get(nextKey) ?? Infinity)) {
        dist.set(nextKey, cost);
        prev.set(nextKey, { key: currentKey, state });
        states.set(nextKey, next);
      }
    }
  }

  if (!bestFinalKey) return null;

  const chain: State[] = [];
  let cursor: string | null = bestFinalKey;
  while (cursor) {
    chain.push(states.get(cursor)!);
    cursor = prev.get(cursor)?.key ?? null;
  }
  return chain.reverse();
}

function directionFor(network: Network, routeId: string, fromId: string, toId: string) {
  for (const pattern of network.patterns) {
    if (pattern.routeId !== routeId) continue;
    const a = pattern.stationIds.indexOf(fromId);
    const b = pattern.stationIds.indexOf(toId);
    if (a !== -1 && b !== -1 && a < b) return pattern.directionId;
  }
  return null;
}

function stationsBetween(network: Network, routeId: string, fromId: string, toId: string): Station[] {
  for (const pattern of network.patterns) {
    if (pattern.routeId !== routeId) continue;
    const a = pattern.stationIds.indexOf(fromId);
    const b = pattern.stationIds.indexOf(toId);
    if (a !== -1 && b !== -1 && a < b) {
      return pattern.stationIds.slice(a, b + 1).map((id) => network.stationById[id]);
    }
  }
  return [network.stationById[fromId], network.stationById[toId]];
}

export function planTrip(
  network: Network,
  originId: string,
  destinationId: string,
  avoid?: Avoid
): PlannedTrip | null {
  if (originId === destinationId) return null;
  if (!network.stationById[originId] || !network.stationById[destinationId]) return null;
  if (avoid?.stations.has(originId) || avoid?.stations.has(destinationId)) return null;

  const chain = searchPath(network, originId, destinationId, avoid);
  if (!chain || chain.length < 2) return null;

  const rides: Ride[] = [];
  let index = 1;
  while (index < chain.length) {
    const routeId = chain[index].routeId;
    const fromId = chain[index - 1].station;
    let end = index;
    while (end + 1 < chain.length && chain[end + 1].routeId === routeId) end += 1;
    const toId = chain[end].station;

    if (fromId !== toId) {
      rides.push({
        routeId,
        directionId: directionFor(network, routeId, fromId, toId),
        from: network.stationById[fromId],
        to: network.stationById[toId],
        stations: stationsBetween(network, routeId, fromId, toId)
      });
    }
    index = end + 1;
  }

  if (!rides.length) return null;

  const steps: TripStep[] = [];
  rides.forEach((ride, i) => {
    steps.push({ kind: "ride", ride });
    const next = rides[i + 1];
    if (next) {
      steps.push({ kind: "transfer", station: ride.to, fromRouteId: ride.routeId, toRouteId: next.routeId });
    }
  });

  return {
    origin: network.stationById[originId],
    destination: network.stationById[destinationId],
    rides,
    steps
  };
}
