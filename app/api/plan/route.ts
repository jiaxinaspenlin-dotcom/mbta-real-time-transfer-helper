import { NextRequest, NextResponse } from "next/server";
import {
  Departure,
  addMinutes,
  fetchDepartures,
  fetchTripArrivals,
  formatClock,
  formatDuration,
  formatMinutes,
  scoreTransfer,
  worstConfidence
} from "@/lib/mbta";
import { MbtaApiError } from "@/lib/mbta-api";
import { loadNetwork, planTrip } from "@/lib/network";

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** A candidate train, checked against the trip's own stop list. */
type Candidate = {
  departure: Departure;
  /** Arrival at this leg's destination, or null if this train never gets there. */
  arrivalIso: string | null;
};

type Leg = {
  routeId: string;
  fromId: string;
  toId: string;
  boarded: Departure | null;
  arrivalIso: string | null;
  candidates: Candidate[];
};

export async function POST(req: NextRequest) {
  let network;
  try {
    network = await loadNetwork();
  } catch (error) {
    const message = error instanceof MbtaApiError ? error.message : "Could not load the MBTA network.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const body = await req.json();
  const { originId, destinationId, departAt } = body;

  if (originId === destinationId) {
    return NextResponse.json({ error: "Pick two different stations to plan a trip." }, { status: 400 });
  }

  const trip = planTrip(network, originId, destinationId);
  if (!trip) {
    return NextResponse.json(
      { error: "No subway route connects those two stations in the MBTA network data." },
      { status: 400 }
    );
  }

  // The rider owns these numbers: how long their own platform walk takes, and the
  // two what-if knobs. Nothing here is assumed on their behalf.
  const walkMinutes = clamp(body.walkMinutes, 1, 15, 3);
  const departShiftMinutes = clamp(body.departShiftMinutes, 0, 60, 0);
  const delayMinutes = clamp(body.delayMinutes, 0, 30, 0);

  const requestedIso = addMinutes(
    departAt ? new Date(departAt).toISOString() : new Date().toISOString(),
    departShiftMinutes
  );

  const legs: Leg[] = [];
  const notes: string[] = [];
  let cursorIso = requestedIso;

  try {
    for (let i = 0; i < trip.rides.length; i += 1) {
      const ride = trip.rides[i];
      const routeName = network.routeById[ride.routeId]?.name ?? ride.routeId;
      const departures = await fetchDepartures({
        stationId: ride.from.id,
        routeId: ride.routeId,
        directionId: ride.directionId,
        afterIso: cursorIso,
        // Wide enough that a branch destination (Braintree, Union Square) still
        // finds a train it can actually use; the arrival lookup stays one request.
        limit: 8
      });

      // Route + direction is not enough: the Red Line splits at JFK/UMass and the
      // Green Line splits four ways, so an eligible-looking train may never reach
      // this leg's destination. Check each candidate against its own stop list.
      const arrivals = await fetchTripArrivals(
        network,
        departures.map((departure) => departure.tripId).filter((id): id is string => Boolean(id)),
        ride.to.id
      );
      const candidates: Candidate[] = departures.map((departure) => {
        const arrival = departure.tripId ? arrivals.get(departure.tripId) : undefined;
        // A stale stop time that lands before the departure is not usable.
        const usable =
          arrival && new Date(arrival).getTime() > new Date(departure.departureTime!).getTime() ? arrival : null;
        return { departure, arrivalIso: usable };
      });

      // On a transfer you can only board something that leaves after you finish walking.
      const earliestBoardIso = i === 0 ? cursorIso : addMinutes(cursorIso, walkMinutes);
      const chosen =
        candidates.find(
          (candidate) =>
            candidate.arrivalIso &&
            new Date(candidate.departure.departureTime!).getTime() >= new Date(earliestBoardIso).getTime()
        ) ?? null;

      const boarded = chosen?.departure ?? null;
      let arrivalIso = chosen?.arrivalIso ?? null;

      if (!boarded) {
        const anyTiming = candidates.some((candidate) =>
          new Date(candidate.departure.departureTime!).getTime() >= new Date(earliestBoardIso).getTime()
        );
        notes.push(
          anyTiming
            ? `No ${routeName} train leaving ${ride.from.name} after ${formatClock(earliestBoardIso)} continues to ${ride.to.name}.`
            : `The MBTA reports no ${routeName} departures from ${ride.from.name} after ${formatClock(earliestBoardIso)}.`
        );
      }

      if (i === 0 && arrivalIso && delayMinutes) {
        arrivalIso = addMinutes(arrivalIso, delayMinutes);
      }

      legs.push({ routeId: ride.routeId, fromId: ride.from.id, toId: ride.to.id, boarded, arrivalIso, candidates });

      if (!arrivalIso) break;
      cursorIso = arrivalIso;
    }
  } catch (error) {
    const message = error instanceof MbtaApiError ? error.message : "The MBTA API did not respond.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const firstLeg = legs[0];
  if (!firstLeg?.boarded) {
    const route = network.routeById[trip.rides[0].routeId];
    return NextResponse.json(
      {
        error: `The MBTA has no live or scheduled ${route?.name ?? trip.rides[0].routeId} departures from ${trip.rides[0].from.name} at that time.`
      },
      { status: 404 }
    );
  }

  type ConnectionOption = {
    departure: string | null;
    headsign: string | null;
    buffer: string | null;
    confidence: string | null;
    source: Departure["source"];
    liveStatus: string | null;
    serves: boolean;
    note: string | null;
    boarding: boolean;
  };

  type LiveConnection = {
    id: string;
    transferAt: string;
    fromRouteId: string;
    toRouteId: string;
    arriveAt: string | null;
    boardAfter: string | null;
    walkMinutes: number;
    confidence: string | null;
    missedFirst: boolean;
    headsign: string | null;
    options: ConnectionOption[];
  };

  const liveConnections: LiveConnection[] = [];
  for (let i = 1; i < legs.length; i += 1) {
    const previous = legs[i - 1];
    const current = legs[i];
    const arrivalIso = previous.arrivalIso;

    const destinationName = network.stationById[current.toId].name;
    // Always show through the train the rider actually boards, so the trains they
    // must let pass are visible rather than silently cut off.
    const boardIndex = current.candidates.findIndex((candidate) => candidate.departure === current.boarded);
    const shown = current.candidates.slice(0, Math.min(6, boardIndex >= 0 ? Math.max(boardIndex + 1, 3) : 4));

    const options = shown.map(({ departure, arrivalIso: candidateArrival }) => {
      const score = scoreTransfer({ arrivalIso, departureIso: departure.departureTime, walkMinutes });
      const serves = Boolean(candidateArrival);
      return {
        departure: formatClock(departure.departureTime),
        headsign: departure.headsign,
        buffer: formatMinutes(score.seconds),
        confidence: serves ? score.label : null,
        source: departure.source,
        liveStatus: departure.status,
        serves,
        note: serves ? null : `Does not continue to ${destinationName}`,
        boarding: serves && departure.departureTime === current.boarded?.departureTime
      };
    });

    liveConnections.push({
      id: `${previous.toId}-${current.routeId}-${i}`,
      transferAt: network.stationById[previous.toId].name,
      fromRouteId: previous.routeId,
      toRouteId: current.routeId,
      arriveAt: formatClock(arrivalIso),
      boardAfter: formatClock(arrivalIso ? addMinutes(arrivalIso, walkMinutes) : null),
      walkMinutes,
      // Confidence describes the train the plan actually puts you on. Whether the
      // earlier ones were catchable is shown per option, so the headline and the
      // itinerary never contradict each other.
      confidence:
        options.find((option) => option.boarding)?.confidence ??
        options.find((option) => option.serves)?.confidence ??
        null,
      missedFirst: Boolean(options.length && options[0].serves && !options[0].boarding),
      headsign: current.boarded?.headsign ?? null,
      options
    });
  }

  const confidence = worstConfidence(liveConnections.map((c) => c.confidence));
  const tightest = liveConnections.reduce<{ seconds: number | null; at: string | null }>(
    (acc, connection, index) => {
      const score = scoreTransfer({
        arrivalIso: legs[index].arrivalIso,
        departureIso: legs[index + 1]?.boarded?.departureTime,
        walkMinutes
      });
      if (score.seconds === null) return acc;
      if (acc.seconds === null || score.seconds < acc.seconds) {
        return { seconds: score.seconds, at: connection.transferAt };
      }
      return acc;
    },
    { seconds: null, at: null }
  );

  const lastLeg = legs[legs.length - 1];
  const arriveIso = lastLeg?.arrivalIso ?? null;
  const departIso = firstLeg.boarded.departureTime!;
  const incomplete = legs.length < trip.rides.length || legs.some((leg) => !leg.boarded || !leg.arrivalIso);

  const directions = trip.steps.map((step, index) => {
    if (step.kind === "transfer") {
      const connection = liveConnections.find((c) => c.transferAt === step.station.name);
      return {
        id: `transfer-${index}`,
        kind: "transfer" as const,
        title: `Transfer at ${step.station.name}`,
        detail: `Walk to the ${network.routeById[step.toRouteId]?.name ?? step.toRouteId} platform.`,
        routeId: null,
        confidence: connection?.confidence ?? null,
        badge: `${walkMinutes} min walk`
      };
    }

    const legIndex = trip.rides.indexOf(step.ride);
    const leg = legs[legIndex];
    const route = network.routeById[step.ride.routeId];
    const stops = Math.max(1, step.ride.stations.length - 1);
    const headsign = leg?.boarded?.headsign;

    return {
      id: `ride-${index}`,
      kind: "ride" as const,
      title: headsign ? `${route?.name ?? step.ride.routeId} toward ${headsign}` : `Board the ${route?.name ?? step.ride.routeId}`,
      detail: `${step.ride.from.name} → ${step.ride.to.name} · ${stops} ${stops === 1 ? "stop" : "stops"}`,
      routeId: step.ride.routeId,
      confidence: null,
      badge: formatClock(leg?.boarded?.departureTime ?? null)
    };
  });

  const sources = new Set(legs.flatMap((leg) => (leg.boarded ? [leg.boarded.source] : [])));

  return NextResponse.json({
    title: `${trip.origin.name} → ${trip.destination.name}`,
    subtitle: trip.rides
      .map((ride) => `${network.routeById[ride.routeId]?.shortName ?? ride.routeId} to ${ride.to.name}`)
      .join(" · "),
    confidence,
    transferWindow: formatMinutes(tightest.seconds),
    tightestAt: tightest.at,
    departAt: formatClock(departIso),
    arriveAt: formatClock(arriveIso),
    duration: formatDuration(departIso, arriveIso),
    nextDeparture: formatClock(legs[1]?.boarded?.departureTime ?? departIso),
    liveStatus: firstLeg.boarded.status,
    transferCount: trip.rides.length - 1,
    dataSource: sources.has("prediction") ? (sources.size > 1 ? "mixed" : "prediction") : "schedule",
    incomplete,
    notes,
    walkMinutes,
    whatIf: { departShiftMinutes, delayMinutes },
    directions,
    geometry: trip.rides.map((ride) => ({
      routeId: ride.routeId,
      points: ride.stations.map((station) => [station.lat, station.lon] as [number, number])
    })),
    markers: [
      { kind: "board" as const, name: trip.origin.name, lat: trip.origin.lat, lon: trip.origin.lon },
      ...trip.steps
        .filter((step): step is Extract<typeof step, { kind: "transfer" }> => step.kind === "transfer")
        .map((step) => ({ kind: "transfer" as const, name: step.station.name, lat: step.station.lat, lon: step.station.lon })),
      { kind: "arrive" as const, name: trip.destination.name, lat: trip.destination.lat, lon: trip.destination.lon }
    ],
    liveConnections
  });
}
