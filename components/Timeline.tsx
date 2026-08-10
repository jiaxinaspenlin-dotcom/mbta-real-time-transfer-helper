"use client";

import { JourneyLeg, journeyState } from "@/lib/time";

type Connection = { transferAt: string; confidence: string | null; walkMinutes: number };

const MIN_SEGMENT_PX = 34;
const PX_PER_MINUTE = 3.2;

function minutesBetween(a?: string | null, b?: string | null) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
}

/**
 * Rides and waits drawn to scale, so a long ride and a two-minute transfer are
 * visibly different rather than three identically sized boxes.
 */
export default function Timeline({
  legs,
  connections,
  now
}: {
  legs: JourneyLeg[];
  connections: Connection[];
  now: number;
}) {
  if (!legs.length) return null;
  const state = journeyState(legs, now);
  const activeIndex = state && state.phase !== "arrived" ? state.leg.index : -1;
  const done = state?.phase === "arrived";

  return (
    <div className="timeline">
      {legs.map((leg, index) => {
        const rideMinutes = minutesBetween(leg.boardIso, leg.arriveIso);
        const height = Math.max(MIN_SEGMENT_PX, (rideMinutes ?? 10) * PX_PER_MINUTE);
        const next = legs[index + 1];
        const waitMinutes = next ? minutesBetween(leg.arriveIso, next.boardIso) : null;
        const connection = connections.find((item) => item.transferAt === leg.toName);
        const isActive = index === activeIndex;
        const isPast = done || index < activeIndex;

        return (
          <div key={leg.index} className={`tlGroup${isPast ? " past" : ""}`}>
            {/* Only the origin gets its own node; every later boarding point is
                already named by the previous group's transfer node. */}
            {index === 0 ? (
              <div className="tlRow">
                <span className="tlDot" style={{ borderColor: leg.routeColor }} />
                <div className="tlLabel">
                  <strong>{leg.fromName}</strong>
                  <span>Leave {leg.boardAt ?? "—"}</span>
                </div>
              </div>
            ) : null}

            <div className={`tlRide${isActive ? " active" : ""}`}>
              <span className="tlBar" style={{ height, background: leg.routeColor }} />
              <div className="tlRideMeta">
                <strong style={{ color: leg.routeColor }}>
                  {leg.mode === "bus" ? `Bus ${leg.routeShortName}` : leg.routeShortName}
                </strong>
                <span>
                  {leg.stops} {leg.stops === 1 ? "stop" : "stops"}
                  {rideMinutes !== null ? ` · ${rideMinutes} min` : ""}
                </span>
                {leg.headsign ? <span className="tlHeadsign">toward {leg.headsign}</span> : null}
              </div>
            </div>

            {next ? (
              <div className="tlRow tlTransferRow">
                <span className="tlDot tlTransferDot" />
                <div className="tlLabel">
                  <strong>{leg.toName}</strong>
                  <span>
                    Arrive {leg.arriveAt ?? "—"} · leave {next.boardAt ?? "—"}
                    {waitMinutes !== null ? ` (${waitMinutes} min)` : ""}
                  </span>
                  {next.walkBefore?.derived && next.walkBefore.meters ? (
                    <span className="tlWalk">
                      ↳ walk {next.walkBefore.meters} m to {next.fromName} ({next.walkBefore.minutes} min)
                    </span>
                  ) : null}
                </div>
                {connection?.confidence ? (
                  <span className={`conf conf-${connection.confidence.toLowerCase()}`}>
                    {connection.confidence}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="tlRow">
                <span className="tlDot tlEnd" />
                <div className="tlLabel">
                  <strong>{leg.toName}</strong>
                  <span>Arrive {leg.arriveAt ?? "—"}</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
