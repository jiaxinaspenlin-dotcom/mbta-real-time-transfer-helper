export type LineId = "Red" | "Orange" | "Blue" | "Green-E";

export type Station = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  lines: LineId[];
  stopId?: string;
};

export const LINE_COLORS: Record<LineId, string> = {
  Red: "#DA291C",
  Orange: "#ED8B00",
  Blue: "#003DA5",
  "Green-E": "#00843D"
};

export const LINE_LABELS: Record<LineId, string> = {
  Red: "Red Line",
  Orange: "Orange Line",
  Blue: "Blue Line",
  "Green-E": "Green Line E"
};

export const STATIONS: Station[] = [
  { id: "alewife", name: "Alewife", lat: 42.395428, lon: -71.142483, lines: ["Red"], stopId: "place-alfcl" },
  { id: "harvard", name: "Harvard", lat: 42.373362, lon: -71.118956, lines: ["Red"], stopId: "place-harsq" },
  { id: "park-street", name: "Park Street", lat: 42.356395, lon: -71.062424, lines: ["Red", "Green-E"], stopId: "place-pktrm" },
  { id: "downtown-crossing", name: "Downtown Crossing", lat: 42.355518, lon: -71.060225, lines: ["Red", "Orange"], stopId: "place-dwnxg" },
  { id: "south-station", name: "South Station", lat: 42.352271, lon: -71.055242, lines: ["Red"], stopId: "place-sstat" },
  { id: "north-station", name: "North Station", lat: 42.365577, lon: -71.06129, lines: ["Orange", "Green-E"], stopId: "place-north" },
  { id: "state", name: "State", lat: 42.358978, lon: -71.057598, lines: ["Orange", "Blue"], stopId: "place-state" },
  { id: "government-center", name: "Government Center", lat: 42.359705, lon: -71.059215, lines: ["Blue", "Green-E"], stopId: "place-gover" },
  { id: "bowdoin", name: "Bowdoin", lat: 42.361365, lon: -71.062037, lines: ["Blue"], stopId: "place-bomnl" },
  { id: "airport", name: "Airport", lat: 42.374262, lon: -71.030395, lines: ["Blue"], stopId: "place-aport" },
  { id: "wonderland", name: "Wonderland", lat: 42.41342, lon: -70.991648, lines: ["Blue"], stopId: "place-wondl" },
  { id: "forest-hills", name: "Forest Hills", lat: 42.300523, lon: -71.113686, lines: ["Orange"], stopId: "place-forhl" },
  { id: "back-bay", name: "Back Bay", lat: 42.34735, lon: -71.075727, lines: ["Orange"], stopId: "place-bbsta" },
  { id: "ruggles", name: "Ruggles", lat: 42.336377, lon: -71.088961, lines: ["Orange"], stopId: "place-rugg" },
  { id: "lechmere", name: "Lechmere", lat: 42.370772, lon: -71.076536, lines: ["Green-E"], stopId: "place-lech" },
  { id: "science-park", name: "Science Park/West End", lat: 42.366664, lon: -71.067666, lines: ["Green-E"], stopId: "place-spmnl" },
  { id: "copley", name: "Copley", lat: 42.349974, lon: -71.077447, lines: ["Green-E"], stopId: "place-coecl" },
  { id: "northeastern", name: "Northeastern University", lat: 42.340401, lon: -71.089633, lines: ["Green-E"], stopId: "place-nuniv" }
];

export const STATION_BY_ID = Object.fromEntries(STATIONS.map((s) => [s.id, s])) as Record<string, Station>;

const LINE_SEQUENCES: Record<LineId, string[]> = {
  Red: ["alewife", "harvard", "park-street", "downtown-crossing", "south-station"],
  Orange: ["forest-hills", "ruggles", "back-bay", "downtown-crossing", "state", "north-station"],
  Blue: ["bowdoin", "government-center", "state", "airport", "wonderland"],
  "Green-E": ["northeastern", "copley", "park-street", "government-center", "north-station", "science-park", "lechmere"]
};

export type TripStep = {
  kind: "ride" | "transfer";
  line?: LineId;
  from: Station;
  to: Station;
  stations: Station[];
};

export type PlannedTrip = {
  origin: Station;
  destination: Station;
  steps: TripStep[];
};

function buildAdjacency() {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => adj.set(a, [...(adj.get(a) ?? []), b]);
  Object.values(LINE_SEQUENCES).forEach((seq) => {
    for (let i = 0; i < seq.length - 1; i += 1) {
      add(seq[i], seq[i + 1]);
      add(seq[i + 1], seq[i]);
    }
  });
  return adj;
}

const ADJ = buildAdjacency();

export function listStations() {
  return STATIONS.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export function stationsForSelect() {
  return listStations().map((station) => ({ value: station.id, label: station.name }));
}

function commonLines(a: Station, b: Station): LineId[] {
  return a.lines.filter((line): line is LineId => b.lines.includes(line));
}

function stationsBetween(line: LineId, fromId: string, toId: string) {
  const seq = LINE_SEQUENCES[line];
  const a = seq.indexOf(fromId);
  const b = seq.indexOf(toId);
  if (a === -1 || b === -1) return [];
  const segment = a <= b ? seq.slice(a, b + 1) : seq.slice(b, a + 1).reverse();
  return segment.map((id) => STATION_BY_ID[id]);
}

function shortestPath(originId: string, destinationId: string) {
  const queue = [originId];
  const prev = new Map<string, string | null>();
  prev.set(originId, null);
  while (queue.length) {
    const current = queue.shift()!;
    if (current === destinationId) break;
    for (const next of ADJ.get(current) ?? []) {
      if (!prev.has(next)) {
        prev.set(next, current);
        queue.push(next);
      }
    }
  }
  if (!prev.has(destinationId)) return null;
  const path: string[] = [];
  let cursor: string | null = destinationId;
  while (cursor) {
    path.push(cursor);
    cursor = prev.get(cursor) ?? null;
  }
  return path.reverse();
}

export function planTrip(originId: string, destinationId: string): PlannedTrip | null {
  if (originId === destinationId) return null;
  const stationPath = shortestPath(originId, destinationId);
  if (!stationPath || stationPath.length < 2) return null;
  const steps: TripStep[] = [];
  let i = 0;
  while (i < stationPath.length - 1) {
    const from = STATION_BY_ID[stationPath[i]];
    const next = STATION_BY_ID[stationPath[i + 1]];
    const line = commonLines(from, next)[0];
    if (!line) return null;
    let j = i + 1;
    while (j < stationPath.length - 1) {
      const current = STATION_BY_ID[stationPath[j]];
      const nxt = STATION_BY_ID[stationPath[j + 1]];
      if (!commonLines(current, nxt).includes(line)) break;
      j += 1;
    }
    const to = STATION_BY_ID[stationPath[j]];
    steps.push({ kind: "ride", line, from, to, stations: stationsBetween(line, from.id, to.id) });
    if (j < stationPath.length - 1) {
      steps.push({ kind: "transfer", from: to, to, stations: [to] });
    }
    i = j;
  }
  return { origin: STATION_BY_ID[originId], destination: STATION_BY_ID[destinationId], steps };
}
