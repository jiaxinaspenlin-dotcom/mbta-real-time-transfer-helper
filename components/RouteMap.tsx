"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";

type LineRoute = { id: string; name: string; shortName: string; color: string };
type Station = { id: string; name: string; lat: number; lon: number; routeIds: string[] };
type Shape = { routeId: string; points: [number, number][] };
/** Trip shapes carry their own colour, since a bus route's palette is not preloaded. */
type TripShape = { kind?: "ride" | "walk"; routeId: string | null; color?: string; points: [number, number][] };
type TripMarker = { kind: "board" | "transfer" | "arrive"; name: string; lat: number; lon: number };

const MARKER_COLORS: Record<TripMarker["kind"], string> = {
  board: "#0f172a",
  transfer: "#b45309",
  arrive: "#15803d"
};

// Short glyphs instead of words: these labels are permanent, and adjacent downtown
// stations sit close enough that full captions overlap each other.
const MARKER_GLYPHS: Record<TripMarker["kind"], string> = {
  board: "▶",
  transfer: "⇄",
  arrive: "◎"
};

const MARKER_TIP_DIRECTION: Record<TripMarker["kind"], "top" | "right" | "bottom"> = {
  board: "top",
  transfer: "right",
  arrive: "bottom"
};

/**
 * Keeps the view correct and, critically, recovers when the map is created inside a
 * hidden container — the mobile tabs mount every panel, so Leaflet would otherwise
 * size itself to 0x0 and never load a tile once the tab is shown.
 */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  const pointsRef = useRef(points);
  pointsRef.current = points;

  const fit = useCallback(() => {
    const current = pointsRef.current;
    if (!current.length) return;
    // Extra headroom at the top: the start marker's permanent label sits above it
    // and would otherwise be clipped by the map edge.
    map.fitBounds(L.latLngBounds(current), {
      paddingTopLeft: [44, 58],
      paddingBottomRight: [44, 44]
    });
  }, [map]);

  const signature = points.length ? `${points.length}:${points[0]}:${points[points.length - 1]}` : "";
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, signature]);

  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      map.invalidateSize();
      fit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [map, fit]);

  return null;
}

export default function RouteMap({
  routes,
  network,
  stations,
  trip,
  markers,
  originId,
  destinationId,
  onSelect
}: {
  routes: LineRoute[];
  network: Shape[];
  stations: Station[];
  trip: TripShape[];
  markers: TripMarker[];
  originId: string;
  destinationId: string;
  onSelect: (stationId: string, role: "origin" | "destination") => void;
}) {
  const colorOf = useMemo(() => {
    const map = new Map(routes.map((route) => [route.id, route.color]));
    return (routeId: string) => map.get(routeId) ?? "#64748b";
  }, [routes]);

  const planned = trip.length > 0;
  const focusPoints = useMemo<[number, number][]>(() => {
    if (planned) return trip.flatMap((shape) => shape.points);
    return network.flatMap((shape) => shape.points);
  }, [planned, trip, network]);

  return (
    <div className={`mapCanvas${planned ? " mapPlanned" : ""}`}>
      <MapContainer center={[42.357, -71.06]} zoom={12} style={{ width: "100%", height: "100%" }} zoomControl>
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={focusPoints} />

        {network.map((shape, idx) => (
          <Polyline
            key={`net-${idx}`}
            positions={shape.points}
            pathOptions={{
              color: colorOf(shape.routeId),
              weight: planned ? 2.5 : 5,
              opacity: planned ? 0.16 : 0.85
            }}
          />
        ))}

        {/* White casing under the route so it reads against a busy basemap. */}
        {trip.map((shape, idx) => (
          <Polyline
            key={`case-${idx}`}
            positions={shape.points}
            pathOptions={{
              color: "#ffffff",
              weight: shape.kind === "walk" ? 9 : 13,
              opacity: 0.95,
              lineCap: "round",
              lineJoin: "round"
            }}
          />
        ))}

        {trip.map((shape, idx) => (
          <Polyline
            key={`trip-${idx}`}
            positions={shape.points}
            pathOptions={
              shape.kind === "walk"
                ? { color: shape.color ?? "#64748b", weight: 5, opacity: 0.95, dashArray: "1 8", lineCap: "round" }
                : { color: shape.color ?? colorOf(shape.routeId ?? ""), weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" }
            }
          />
        ))}

        {/* Every stop actually ridden through, so the count is visible on the map. */}
        {trip.flatMap((shape, shapeIdx) =>
          shape.kind === "walk"
            ? []
            : shape.points.slice(1, -1).map((point, i) => (
                <CircleMarker
                  key={`stop-${shapeIdx}-${i}`}
                  center={point}
                  radius={3.5}
                  pathOptions={{
                    color: shape.color ?? "#334155",
                    fillColor: "#ffffff",
                    fillOpacity: 1,
                    weight: 2.5
                  }}
                />
              ))
        )}

        {stations.map((station) => {
          const isEndpoint = station.id === originId || station.id === destinationId;
          const isInterchange = station.routeIds.length > 1;
          // Once a route is drawn, 125 station dots are noise. They stay clickable
          // so you can still re-plan from the map, just visually out of the way.
          const radius = planned ? (isEndpoint ? 8 : 2.5) : isEndpoint ? 8 : isInterchange ? 5 : 3.5;
          return (
            <CircleMarker
              key={station.id}
              center={[station.lat, station.lon]}
              radius={radius}
              pathOptions={{
                color: isEndpoint ? "#0f172a" : colorOf(station.routeIds[0]),
                fillColor: "#ffffff",
                fillOpacity: 1,
                weight: isEndpoint ? 3 : 2,
                opacity: planned && !isEndpoint ? 0.35 : 1
              }}
            >
              <Tooltip direction="top" offset={[0, -6]}>
                {station.name}
              </Tooltip>
              <Popup>
                <div className="mapPopup">
                  <strong>{station.name}</strong>
                  <div className="mapPopupLines">
                    {station.routeIds.map((routeId) => (
                      <span key={routeId} style={{ background: colorOf(routeId) }}>
                        {routes.find((route) => route.id === routeId)?.shortName ?? routeId}
                      </span>
                    ))}
                  </div>
                  <div className="mapPopupActions">
                    <button type="button" onClick={() => onSelect(station.id, "origin")}>
                      Start here
                    </button>
                    <button type="button" onClick={() => onSelect(station.id, "destination")}>
                      End here
                    </button>
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}

        {markers.map((marker, idx) => (
          <CircleMarker
            key={`marker-${marker.name}-${idx}`}
            center={[marker.lat, marker.lon]}
            radius={marker.kind === "transfer" ? 9 : 11}
            pathOptions={{
              color: MARKER_COLORS[marker.kind],
              fillColor: "#ffffff",
              fillOpacity: 1,
              weight: 4
            }}
          >
            <Tooltip
              direction={MARKER_TIP_DIRECTION[marker.kind]}
              offset={marker.kind === "transfer" ? [10, 0] : [0, marker.kind === "board" ? -10 : 10]}
              className="tripTip"
              permanent
            >
              {MARKER_GLYPHS[marker.kind]} {marker.name}
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
