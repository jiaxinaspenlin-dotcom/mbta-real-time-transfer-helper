import { NextRequest, NextResponse } from "next/server";
import { MbtaApiError } from "@/lib/mbta-api";
import { loadNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

const LIMIT = 40;

/**
 * Stop search. With ~6,900 stops across subway and bus, shipping the whole list to
 * the browser is not an option, so filtering happens here.
 */
export async function GET(req: NextRequest) {
  let network;
  try {
    network = await loadNetwork();
  } catch (error) {
    const message = error instanceof MbtaApiError ? error.message : "Could not load the MBTA network.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const query = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  const ids = req.nextUrl.searchParams.getAll("id");

  // Resolving ids is how a deep link shows a stop name it never searched for.
  if (ids.length) {
    return NextResponse.json({
      stops: ids
        .map((id) => network.stationById[id])
        .filter(Boolean)
        .map((station) => ({
          id: station.id,
          name: station.name,
          routeIds: station.routeIds,
          mode: station.mode
        }))
    });
  }

  if (!query) {
    // No query: offer subway stations, which is the common case.
    return NextResponse.json({
      stops: network.stations
        .filter((station) => station.mode === "subway")
        .slice(0, LIMIT)
        .map((station) => ({ id: station.id, name: station.name, routeIds: station.routeIds, mode: station.mode }))
    });
  }

  const starts: typeof network.stations = [];
  const contains: typeof network.stations = [];
  for (const station of network.stations) {
    const name = station.name.toLowerCase();
    if (name.startsWith(query)) starts.push(station);
    else if (name.includes(query)) contains.push(station);
  }

  // Subway first within each tier: a rider searching "Harvard" wants the station,
  // not the twelve bus stops named after it.
  const rank = (station: (typeof network.stations)[number]) => (station.mode === "subway" ? 0 : 1);
  const ordered = [...starts.sort((a, b) => rank(a) - rank(b)), ...contains.sort((a, b) => rank(a) - rank(b))];

  return NextResponse.json({
    stops: ordered.slice(0, LIMIT).map((station) => ({
      id: station.id,
      name: station.name,
      routeIds: station.routeIds,
      mode: station.mode
    }))
  });
}
