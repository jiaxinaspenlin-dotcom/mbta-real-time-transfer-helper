"use client";

import { JourneyLeg, countdown, journeyProgress, journeyState, minutesUntil } from "@/lib/time";

type Connection = { transferAt: string; confidence: string | null; walkMinutes: number };

function confidenceClass(label: string | null) {
  return label ? `conf conf-${label.toLowerCase()}` : "conf conf-unknown";
}

/**
 * The single "what do I do right now?" answer, recomputed from the clock so it
 * advances through board -> ride -> transfer -> arrived on its own.
 */
export default function NowCard({
  legs,
  connections,
  destinationName,
  now,
  onReturnTrip
}: {
  legs: JourneyLeg[];
  connections: Connection[];
  destinationName: string;
  now: number;
  onReturnTrip: () => void;
}) {
  const state = journeyState(legs, now);
  if (!state) return null;

  const progress = journeyProgress(legs, now);

  if (state.phase === "arrived") {
    return (
      <div className="nowCard nowArrived">
        <div className="nowKicker">Trip complete</div>
        <h2>You’ve arrived at {destinationName}</h2>
        <p>Hope the connections held up.</p>
        <button type="button" className="primaryButton" onClick={onReturnTrip}>
          Plan the trip back
        </button>
      </div>
    );
  }

  const { leg } = state;
  const accent = leg.routeColor;

  if (state.phase === "toBoard") {
    const mins = minutesUntil(leg.boardIso, now);
    return (
      <div className="nowCard" style={{ borderLeftColor: accent }}>
        <div className="nowKicker">Right now</div>
        <h2>
          Board the {leg.routeName}
          {leg.headsign ? <span className="nowToward"> toward {leg.headsign}</span> : null}
        </h2>
        <p>
          at <strong>{leg.fromName}</strong>
        </p>
        <div className="nowBig" style={{ color: accent }}>
          {mins === 0 ? "Departing now" : `${mins} min`}
        </div>
        <div className="nowFoot">
          <span className="badge">Leaves {leg.boardAt}</span>
          <span className="badge">{leg.stops} stops to {leg.toName}</span>
        </div>
        <div className="nowRail" aria-hidden>
          <i style={{ width: `${progress * 100}%`, background: accent }} />
        </div>
      </div>
    );
  }

  if (state.phase === "riding") {
    const mins = minutesUntil(leg.arriveIso, now);
    const isFinalLeg = leg.index === legs.length - 1;
    return (
      <div className="nowCard" style={{ borderLeftColor: accent }}>
        <div className="nowKicker">On board</div>
        <h2>
          {leg.routeName}
          {leg.headsign ? <span className="nowToward"> toward {leg.headsign}</span> : null}
        </h2>
        <p>
          {isFinalLeg ? "Ride to" : "Get off at"} <strong>{leg.toName}</strong>
        </p>
        <div className="nowBig" style={{ color: accent }}>
          {mins === 0 ? "Arriving now" : `${mins} min`}
        </div>
        <div className="nowFoot">
          <span className="badge">Arrives {leg.arriveAt}</span>
          {!isFinalLeg && leg.walkMinutesAfter ? (
            <span className="badge">Then a {leg.walkMinutesAfter} min walk</span>
          ) : null}
        </div>
        <div className="nowRail" aria-hidden>
          <i style={{ width: `${progress * 100}%`, background: accent }} />
        </div>
      </div>
    );
  }

  // Transferring: off one train, waiting for the next.
  const connection = connections.find((item) => item.transferAt === state.previous.toName);
  const mins = minutesUntil(leg.boardIso, now);
  return (
    <div className="nowCard nowTransfer" style={{ borderLeftColor: accent }}>
      <div className="nowKicker">Transfer now</div>
      <h2>
        {leg.walkBefore?.derived && leg.walkBefore.meters
          ? `Walk ${leg.walkBefore.meters} m to ${leg.fromName}`
          : `Walk to the ${leg.routeShortName} platform`}
        <span className="nowToward"> at {state.previous.toName}</span>
      </h2>
      <p>
        Next {leg.routeName}
        {leg.headsign ? ` toward ${leg.headsign}` : ""}
      </p>
      <div className="nowBig" style={{ color: accent }}>
        {mins === 0 ? "Leaving now" : `${mins} min`}
      </div>
      <div className="nowFoot">
        <span className="badge">Leaves {leg.boardAt}</span>
        <span className="badge">
          {leg.walkBefore?.minutes ?? connection?.walkMinutes ?? 0} min walk
        </span>
        {connection?.confidence ? (
          <span className={confidenceClass(connection.confidence)}>{connection.confidence}</span>
        ) : null}
      </div>
      <div className="nowRail" aria-hidden>
        <i style={{ width: `${progress * 100}%`, background: accent }} />
      </div>
    </div>
  );
}
