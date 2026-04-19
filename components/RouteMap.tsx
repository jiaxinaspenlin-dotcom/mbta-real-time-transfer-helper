"use client";

import { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { LINE_COLORS } from "@/lib/network";

type GeometryLine = { line: keyof typeof LINE_COLORS; points: [number, number][] };
type Marker = { kind: "board" | "transfer" | "arrive"; name: string; lat: number; lon: number };

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map(([lat, lon]) => [lat, lon]));
    map.fitBounds(bounds, { padding: [32, 32] });
  }, [map, points]);
  return null;
}

export default function RouteMap({ geometry, markers }: { geometry: GeometryLine[]; markers: Marker[] }) {
  const points = useMemo(() => geometry.flatMap((g) => g.points), [geometry]);
  const center: [number, number] = points.length ? points[0] : [42.357, -71.06];
  return (
    <div className="mapCanvas">
      <MapContainer center={center} zoom={12} style={{ width: "100%", height: "100%" }} zoomControl>
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        {geometry.map((segment, idx) => (
          <Polyline key={idx} positions={segment.points} pathOptions={{ color: LINE_COLORS[segment.line], weight: 7, opacity: 0.95 }} />
        ))}
        {markers.map((marker, idx) => (
          <CircleMarker
            key={`${marker.name}-${idx}`}
            center={[marker.lat, marker.lon]}
            radius={marker.kind === "transfer" ? 8 : 10}
            pathOptions={{
              color: marker.kind === "board" ? "#0f172a" : marker.kind === "transfer" ? "#f59e0b" : "#16a34a",
              fillColor: "#ffffff",
              fillOpacity: 1,
              weight: 4
            }}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={1}>
              {marker.kind === "board" ? "Board" : marker.kind === "transfer" ? "Transfer" : "Arrive"}: {marker.name}
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
