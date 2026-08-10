import { NextResponse } from "next/server";
import { MbtaApiError } from "@/lib/mbta-api";
import { loadNetwork, networkGeometry } from "@/lib/network";

// The network is cached in-process and at the fetch layer; never frozen at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const network = await loadNetwork();
    // Subway only. The full graph includes ~6,800 bus stops, which is far too much
    // to ship to a browser and far too many markers for Leaflet to draw.
    return NextResponse.json({
      routes: network.routes.filter((route) => route.mode === "subway"),
      stations: network.stations.filter((station) => station.mode === "subway"),
      geometry: networkGeometry(network)
    });
  } catch (error) {
    const message =
      error instanceof MbtaApiError ? error.message : "Could not load the MBTA network from the MBTA API.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
