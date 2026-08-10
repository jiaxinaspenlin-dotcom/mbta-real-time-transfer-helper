import { MbtaApiError, mbtaFetch } from "./mbta-api";

export type RouteMode = "subway" | "bus";

export type LineRoute = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  textColor: string;
  sortOrder: number;
  mode: RouteMode;
};

export type Station = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  routeIds: string[];
  mode: RouteMode;
};

/** A walking connection between two physically distinct stops. */
export type WalkEdge = { to: string; meters: number };

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
  /** Short walks between nearby stops — what makes bus/subway transfers possible. */
  walkEdges: Map<string, WalkEdge[]>;
};

/** How far riders will plausibly walk between two stops, and how fast. */
const MAX_TRANSFER_WALK_M = 400;
const MAX_WALK_LINKS_PER_STOP = 6;
export const WALK_METRES_PER_MIN = 80;

export function walkMinutesForMeters(meters: number) {
  return Math.max(1, Math.round(meters / WALK_METRES_PER_MIN));
}

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/**
 * Link stops that are close enough to walk between. Bucketed into a coarse grid so
 * this stays linear-ish: comparing all ~6,900 stops pairwise would be 47M checks.
 */
function buildWalkEdges(stations: Station[]): Map<string, WalkEdge[]> {
  const CELL = 0.005; // ~550m of latitude
  const grid = new Map<string, Station[]>();
  const key = (lat: number, lon: number) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

  for (const station of stations) {
    const k = key(station.lat, station.lon);
    const bucket = grid.get(k);
    if (bucket) bucket.push(station);
    else grid.set(k, [station]);
  }

  const edges = new Map<string, WalkEdge[]>();
  for (const station of stations) {
    const baseLat = Math.floor(station.lat / CELL);
    const baseLon = Math.floor(station.lon / CELL);
    const near: WalkEdge[] = [];

    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        for (const other of grid.get(`${baseLat + dLat}:${baseLon + dLon}`) ?? []) {
          if (other.id === station.id) continue;
          const meters = haversineMeters(station.lat, station.lon, other.lat, other.lon);
          if (meters <= MAX_TRANSFER_WALK_M) near.push({ to: other.id, meters });
        }
      }
    }

    near.sort((a, b) => a.meters - b.meters);
    if (near.length) edges.set(station.id, near.slice(0, MAX_WALK_LINKS_PER_STOP));
  }
  return edges;
}

const NETWORK_TTL_MS = 12 * 60 * 60 * 1000;
let cached: { at: number; network: Network } | null = null;

/** Strip the redundant "Line" suffix so pills stay short; keep whatever the API gives otherwise. */
function shortenRouteName(longName: string) {
  return longName.replace(/\s+Line\b/, "").trim() || longName;
}

function readRoutes(payload: any, mode: RouteMode): LineRoute[] {
  return (payload?.data ?? []).map((item: any) => ({
    id: item.id,
    name: item.attributes?.long_name || item.attributes?.short_name || item.id,
    shortName:
      mode === "bus"
        ? item.attributes?.short_name || item.id
        : shortenRouteName(item.attributes?.long_name ?? item.id),
    color: `#${item.attributes?.color ?? "6B7280"}`,
    textColor: `#${item.attributes?.text_color ?? "FFFFFF"}`,
    sortOrder: item.attributes?.sort_order ?? 0,
    mode
  }));
}

const BUS_BATCH = 25;

async function buildNetwork(): Promise<Network> {
  const [subwayRouteResponse, busRouteResponse] = await Promise.all([
    mbtaFetch<any>("/routes", { "filter[type]": "0,1", sort: "sort_order" }, 86400),
    mbtaFetch<any>("/routes", { "filter[type]": "3", sort: "sort_order" }, 86400)
  ]);

  const subwayRoutes = readRoutes(subwayRouteResponse, "subway");
  const busRoutes = readRoutes(busRouteResponse, "bus");
  const routes = [...subwayRoutes, ...busRoutes];

  if (!subwayRoutes.length) {
    throw new MbtaApiError("The MBTA API returned no subway routes.");
  }

  const stationById: Record<string, Station> = {};
  const platformToStation: Record<string, string> = {};
  const patterns: Pattern[] = [];

  const ingest = (payload: any, mode: RouteMode, onlyCanonical: boolean) => {
    const included = new Map<string, any>(
      (payload?.included ?? []).map((item: any) => [`${item.type}:${item.id}`, item])
    );

    for (const item of payload?.data ?? []) {
      // Bus routes carry no canonical flag, so fall back to "typical" patterns.
      if (!onlyCanonical && item.attributes?.typicality !== 1) continue;

      const tripRef = item.relationships?.representative_trip?.data;
      if (!tripRef) continue;
      const trip = included.get(`trip:${tripRef.id}`);
      const stopRefs = trip?.relationships?.stops?.data ?? [];
      const routeId = item.relationships.route.data.id;

      const stationIds: string[] = [];
      for (const stopRef of stopRefs) {
        const stop = included.get(`stop:${stopRef.id}`);
        if (!stop) continue;
        // Subway platforms roll up to a parent station; bus stops stand alone.
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
            routeIds: [],
            mode
          };
        }
        const station = stationById[parentId];
        // A stop served by both modes is a subway station in the UI's eyes.
        if (mode === "subway") station.mode = "subway";
        if (!station.routeIds.includes(routeId)) station.routeIds.push(routeId);
        if (stationIds[stationIds.length - 1] !== parentId) stationIds.push(parentId);
      }

      if (stationIds.length < 2) continue;
      patterns.push({
        id: item.id,
        routeId,
        directionId: item.attributes?.direction_id ?? 0,
        name: item.attributes?.name ?? item.id,
        stationIds
      });
    }
  };

  ingest(
    await mbtaFetch<any>(
      "/route_patterns",
      {
        "filter[route]": subwayRoutes.map((r) => r.id).join(","),
        "filter[canonical]": "true",
        include: "representative_trip.stops"
      },
      86400
    ),
    "subway",
    true
  );

  if (!patterns.length) {
    throw new MbtaApiError("The MBTA API returned no canonical route patterns.");
  }

  // ~5.8 MB across 149 routes, so this is paged and cached hard.
  const busBatches: string[][] = [];
  for (let i = 0; i < busRoutes.length; i += BUS_BATCH) {
    busBatches.push(busRoutes.slice(i, i + BUS_BATCH).map((route) => route.id));
  }
  const busPayloads = await Promise.all(
    busBatches.map((batch) =>
      mbtaFetch<any>(
        "/route_patterns",
        { "filter[route]": batch.join(","), include: "representative_trip.stops" },
        86400
      ).catch(() => null)
    )
  );
  for (const payload of busPayloads) {
    if (payload) ingest(payload, "bus", false);
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
  const allStations = Object.values(stationById).sort((a, b) => a.name.localeCompare(b.name));

  return {
    routes: activeRoutes,
    routeById: Object.fromEntries(activeRoutes.map((route) => [route.id, route])),
    stations: allStations,
    stationById,
    patterns,
    platformToStation,
    adjacency,
    walkEdges: buildWalkEdges(allStations)
  };
}

export async function loadNetwork(): Promise<Network> {
  if (cached && Date.now() - cached.at < NETWORK_TTL_MS) return cached.network;
  const network = await buildNetwork();
  cached = { at: Date.now(), network };
  return network;
}

/**
 * Line shapes for the map. Subway only: drawing 149 bus routes would swamp both the
 * payload and the map, so bus appears only as part of a planned trip.
 */
export function networkGeometry(network: Network) {
  return network.patterns
    .filter((pattern) => pattern.directionId === 0)
    .filter((pattern) => network.routeById[pattern.routeId]?.mode === "subway")
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

export type Walk = { from: Station; to: Station; meters: number; minutes: number };

export type Segment = { kind: "ride"; ride: Ride } | { kind: "walk"; walk: Walk };

export type TripStep =
  | { kind: "ride"; ride: Ride }
  | { kind: "transfer"; station: Station; fromRouteId: string; toRouteId: string }
  | { kind: "walk"; walk: Walk };

export type PlannedTrip = {
  origin: Station;
  destination: Station;
  /** Rides and walks in travel order. */
  segments: Segment[];
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

/**
 * Search costs in rough minutes. These only rank candidate routes; every time a
 * rider is shown still comes from a real prediction, never from these numbers.
 */
const COST = {
  subwayHop: 2,
  // Bus stops sit ~250m apart against ~1km for subway, so a bus hop is much
  // cheaper than a subway hop even though the bus is slower overall. The waiting
  // penalty below is what actually discourages bus legs.
  busHop: 1.2,
  boardSubway: 5,
  boardBus: 9,
  /** Discourages threading a trip through many short walks. */
  walkPenalty: 2
};

const WALK = " walk";

/** Binary min-heap: a linear scan was fine for 125 stations, not for ~7,000 stops. */
class MinHeap {
  private items: Array<{ key: string; cost: number }> = [];

  push(key: string, cost: number) {
    const items = this.items;
    items.push({ key, cost });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].cost <= items[i].cost) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop() {
    const items = this.items;
    if (!items.length) return null;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left].cost < items[smallest].cost) smallest = left;
        if (right < items.length && items[right].cost < items[smallest].cost) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }

  get size() {
    return this.items.length;
  }
}

type State = { station: string; routeId: string };

/**
 * Time-shaped Dijkstra over subway, bus and short walks between them. Boarding
 * penalties are what keep it from suggesting six buses to save one transfer.
 */
function searchPath(network: Network, originId: string, destinationId: string, avoid?: Avoid) {
  const keyOf = (s: State) => `${s.station}|${s.routeId}`;
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const states = new Map<string, State>();
  const heap = new MinHeap();

  const relax = (next: State, cost: number, fromKey: string | null) => {
    const key = keyOf(next);
    if (cost >= (dist.get(key) ?? Infinity)) return;
    dist.set(key, cost);
    prev.set(key, fromKey);
    states.set(key, next);
    heap.push(key, cost);
  };

  const boardCost = (routeId: string) =>
    network.routeById[routeId]?.mode === "bus" ? COST.boardBus : COST.boardSubway;
  const hopCost = (routeId: string) =>
    network.routeById[routeId]?.mode === "bus" ? COST.busHop : COST.subwayHop;

  // Start either by boarding at the origin, or by walking to a nearby stop first.
  for (const edge of network.adjacency.get(originId) ?? []) {
    if (edgeBlocked(avoid, edge.routeId, originId, edge.to)) continue;
    relax({ station: originId, routeId: edge.routeId }, boardCost(edge.routeId), null);
  }
  relax({ station: originId, routeId: WALK }, 0, null);

  const visited = new Set<string>();
  let bestFinalKey: string | null = null;

  while (heap.size) {
    const top = heap.pop()!;
    if (visited.has(top.key)) continue;
    visited.add(top.key);
    const currentCost = dist.get(top.key)!;
    const state = states.get(top.key)!;

    if (state.station === destinationId && state.routeId !== WALK) {
      bestFinalKey = top.key;
      break;
    }
    // Reaching the destination on foot is a valid end too.
    if (state.station === destinationId) {
      bestFinalKey = top.key;
      break;
    }

    for (const edge of network.adjacency.get(state.station) ?? []) {
      if (avoid?.stations.has(edge.to)) continue;
      if (edgeBlocked(avoid, edge.routeId, state.station, edge.to)) continue;
      const changing = edge.routeId !== state.routeId;
      relax(
        { station: edge.to, routeId: edge.routeId },
        currentCost + hopCost(edge.routeId) + (changing ? boardCost(edge.routeId) : 0),
        top.key
      );
    }

    // No walk-after-walk: one hop between stops is a transfer, several is a hike.
    if (state.routeId === WALK) continue;
    for (const walk of network.walkEdges.get(state.station) ?? []) {
      if (avoid?.stations.has(walk.to)) continue;
      relax(
        { station: walk.to, routeId: WALK },
        currentCost + walkMinutesForMeters(walk.meters) + COST.walkPenalty,
        top.key
      );
    }
  }

  if (!bestFinalKey) return null;

  const chain: State[] = [];
  let cursor: string | null = bestFinalKey;
  while (cursor) {
    chain.push(states.get(cursor)!);
    cursor = prev.get(cursor) ?? null;
  }
  return chain.reverse();
}

export const WALK_ROUTE_ID = WALK;

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

  const segments: Segment[] = [];
  let index = 1;
  while (index < chain.length) {
    const current = chain[index];
    const fromId = chain[index - 1].station;

    if (current.routeId === WALK) {
      if (fromId !== current.station) {
        const from = network.stationById[fromId];
        const to = network.stationById[current.station];
        const meters = haversineMeters(from.lat, from.lon, to.lat, to.lon);
        segments.push({
          kind: "walk",
          walk: { from, to, meters: Math.round(meters), minutes: walkMinutesForMeters(meters) }
        });
      }
      index += 1;
      continue;
    }

    const routeId = current.routeId;
    let end = index;
    while (end + 1 < chain.length && chain[end + 1].routeId === routeId) end += 1;
    const toId = chain[end].station;

    if (fromId !== toId) {
      segments.push({
        kind: "ride",
        ride: {
          routeId,
          directionId: directionFor(network, routeId, fromId, toId),
          from: network.stationById[fromId],
          to: network.stationById[toId],
          stations: stationsBetween(network, routeId, fromId, toId)
        }
      });
    }
    index = end + 1;
  }

  const rides = segments.filter((s): s is { kind: "ride"; ride: Ride } => s.kind === "ride").map((s) => s.ride);
  if (!rides.length) return null;

  const steps: TripStep[] = [];
  segments.forEach((segment, i) => {
    if (segment.kind === "walk") {
      steps.push({ kind: "walk", walk: segment.walk });
      return;
    }
    steps.push({ kind: "ride", ride: segment.ride });
    // An in-station change only counts as a transfer when no walk separates them.
    const next = segments[i + 1];
    if (next?.kind === "ride") {
      steps.push({
        kind: "transfer",
        station: segment.ride.to,
        fromRouteId: segment.ride.routeId,
        toRouteId: next.ride.routeId
      });
    }
  });

  return {
    origin: network.stationById[originId],
    destination: network.stationById[destinationId],
    segments,
    rides,
    steps
  };
}
