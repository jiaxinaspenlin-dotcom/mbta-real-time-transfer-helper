import { NextRequest, NextResponse } from "next/server";
import {
  Departure,
  ServiceAlert,
  addMinutes,
  blockedFromAlerts,
  fetchAlerts,
  fetchDepartures,
  fetchTripArrivals,
  formatClock,
  formatDuration,
  formatMinutes,
  isDisabling,
  scoreTransfer,
  worstConfidence
} from "@/lib/mbta";
import { MbtaApiError } from "@/lib/mbta-api";
import { Network, PlannedTrip, emptyAvoid, loadNetwork, planTrip, tripUsesBlocked } from "@/lib/network";

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** "Green Line suspension" reads better than "Green C, Green D, Green E, Green B suspension". */
function describeDisruption(alert: ServiceAlert, network: Network) {
  const names = Array.from(
    new Set(alert.routeIds.map((id) => network.routeById[id]?.shortName ?? id))
  ).sort();
  const grouped = names.every((name) => name.startsWith("Green")) && names.length > 1 ? ["Green Line"] : names;
  const effect = alert.effect.toLowerCase().replace(/_/g, " ");
  return `${grouped.join(" / ")} ${effect}`;
}

/** Bus long names are route descriptions ("Central Square - Broadway Station"), so
 *  buses read better by number. */
function routeLabel(route: { mode: string; name: string; shortName: string } | undefined, fallback: string) {
  if (!route) return fallback;
  return route.mode === "bus" ? `Bus ${route.shortName}` : route.name;
}

function describeAlert(alert: ServiceAlert, network: Network) {
  return {
    id: alert.id,
    header: alert.header,
    effect: alert.effect,
    severity: alert.severity,
    routeNames: alert.routeIds.map((routeId) => network.routeById[routeId]?.shortName ?? routeId)
  };
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
  /** Minutes of walking before this leg: the rider's setting inside a station, or
   *  a real distance-derived figure when the transfer is between separate stops. */
  walkBeforeMinutes: number;
  walkBeforeMeters: number | null;
};

export async function POST(req: NextRequest) {
  let network: Network;
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

  let trip = planTrip(network, originId, destinationId);
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

  // Alerts for the whole subway, not just this trip's lines: an alternative route
  // can only be judged if we know what is broken everywhere. Advisory — a failure
  // here must never sink an otherwise good plan.
  let allAlerts: ServiceAlert[] = [];
  try {
    allAlerts = await fetchAlerts(
      network,
      network.routes.map((route) => route.id)
    );
  } catch {
    allAlerts = [];
  }

  const blocked = blockedFromAlerts(allAlerts);
  let rerouted: { reason: string } | null = null;

  // A closed origin or destination cannot be routed around.
  const closedEndpoint = [originId, destinationId].find((id) => blocked.stations.has(id));
  if (closedEndpoint) {
    const closure = allAlerts.find(
      (alert) => alert.effect === "STATION_CLOSURE" && alert.stationIds.includes(closedEndpoint)
    );
    return NextResponse.json(
      {
        error: `${network.stationById[closedEndpoint].name} is closed right now, so this trip is not possible.`,
        alerts: closure ? [describeAlert(closure, network)] : []
      },
      { status: 404 }
    );
  }

  // Plan around a suspension before wasting requests on trains that will not run.
  if (tripUsesBlocked(trip, blocked)) {
    const alternative = planTrip(network, originId, destinationId, blocked);
    const culprit = allAlerts
      .filter((alert) => isDisabling(alert.effect))
      .filter((alert) =>
        alert.entities.some(
          (entity) =>
            entity.routeId &&
            trip!.rides.some(
              (ride) =>
                ride.routeId === entity.routeId &&
                (!entity.stationId || ride.stations.some((station) => station.id === entity.stationId))
            )
        )
      )
      .sort((a, b) => b.severity - a.severity)[0];

    const culpritLabel = culprit ? describeDisruption(culprit, network) : "a service disruption";

    if (alternative) {
      trip = alternative;
      rerouted = { reason: `Routed around the ${culpritLabel}.` };
    } else {
      rerouted = { reason: `No way around the ${culpritLabel} on the subway — showing the blocked route.` };
    }
  }

  const tripRouteIds = trip.rides.map((ride) => ride.routeId);
  const tripStationIds = new Set(trip.rides.flatMap((ride) => ride.stations.map((station) => station.id)));

  // Show alerts touching the final route, plus whatever forced the detour.
  const alerts = allAlerts
    .filter((alert) => {
      const onRoute = alert.routeIds.some((routeId) => tripRouteIds.includes(routeId));
      if (!onRoute) return false;
      return alert.wholeRoute || alert.stationIds.some((id) => tripStationIds.has(id));
    })
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 4)
    .map((alert) => describeAlert(alert, network));

  /** Resolve a planned route into real boarded trains. Runs again for a reroute. */
  async function buildItinerary(candidateTrip: PlannedTrip) {
  const legs: Leg[] = [];
  const notes: string[] = [];
  let cursorIso = requestedIso;

  {
    let pendingWalkMinutes = 0;
    let pendingWalkMeters: number | null = null;

    for (let segmentIndex = 0; segmentIndex < candidateTrip.segments.length; segmentIndex += 1) {
      const segment = candidateTrip.segments[segmentIndex];

      // A walk between separate stops just consumes time before the next boarding.
      if (segment.kind === "walk") {
        pendingWalkMinutes += segment.walk.minutes;
        pendingWalkMeters = (pendingWalkMeters ?? 0) + segment.walk.meters;
        continue;
      }

      const ride = segment.ride;
      const i = legs.length;
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

      // On a transfer you can only board something that leaves after you finish
      // walking — whether that walk is between platforms or between street stops.
      const walkBefore = i === 0 ? 0 : pendingWalkMinutes || walkMinutes;
      const earliestBoardIso = addMinutes(cursorIso, walkBefore);
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

      legs.push({
        routeId: ride.routeId,
        fromId: ride.from.id,
        toId: ride.to.id,
        boarded,
        arrivalIso,
        candidates,
        walkBeforeMinutes: walkBefore,
        walkBeforeMeters: pendingWalkMeters
      });
      pendingWalkMinutes = 0;
      pendingWalkMeters = null;

      if (!arrivalIso) break;
      cursorIso = arrivalIso;
    }
  }

    const complete =
      legs.length === candidateTrip.rides.length && legs.every((leg) => leg.boarded && leg.arrivalIso);
    return { legs, notes, complete };
  }

  let itinerary;
  try {
    itinerary = await buildItinerary(trip);

    // The feed can dry up for reasons no alert covers. If the plan does not hold
    // together, try again without the route that failed before giving up.
    if (!itinerary.complete) {
      const failedIndex = itinerary.legs.findIndex((leg) => !leg.boarded || !leg.arrivalIso);
      const failedRouteId = trip.rides[failedIndex >= 0 ? failedIndex : 0]?.routeId;
      if (failedRouteId && !rerouted) {
        const detour = emptyAvoid();
        blocked.routes.forEach((id) => detour.routes.add(id));
        blocked.stations.forEach((id) => detour.stations.add(id));
        blocked.routeStops.forEach((key) => detour.routeStops.add(key));
        detour.routes.add(failedRouteId);

        const alternative = planTrip(network, originId, destinationId, detour);
        if (alternative) {
          const attempt = await buildItinerary(alternative);
          if (attempt.complete) {
            const routeName = network.routeById[failedRouteId]?.name ?? failedRouteId;
            trip = alternative;
            itinerary = attempt;
            rerouted = { reason: `Routed around the ${routeName}, which has no service right now.` };
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof MbtaApiError ? error.message : "The MBTA API did not respond.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const { legs, notes } = itinerary;
  const firstLeg = legs[0];
  if (!firstLeg?.boarded) {
    const route = network.routeById[trip.rides[0].routeId];
    return NextResponse.json(
      {
        error: `The MBTA has no live or scheduled ${route?.name ?? trip.rides[0].routeId} departures from ${trip.rides[0].from.name} at that time.`,
        // A suspension or closure is usually the reason; hand it back so the UI
        // can say why instead of just failing.
        alerts,
        rerouted
      },
      { status: 404 }
    );
  }

  type ConnectionOption = {
    departure: string | null;
    /** Raw timestamp so the client can count down without drifting. */
    departureIso: string | null;
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
    arriveIso: string | null;
    boardAfter: string | null;
    boardAfterIso: string | null;
    walkMinutes: number;
    walkMeters: number | null;
    confidence: string | null;
    missedFirst: boolean;
    headsign: string | null;
    explain: string | null;
    options: ConnectionOption[];
  };

  const liveConnections: LiveConnection[] = [];
  for (let i = 1; i < legs.length; i += 1) {
    const previous = legs[i - 1];
    const current = legs[i];
    const arrivalIso = previous.arrivalIso;

    const destinationName = network.stationById[current.toId].name;
    // Per-leg: a street transfer has a real distance, an in-station one uses the setting.
    const legWalkMinutes = current.walkBeforeMinutes;
    // Always show through the train the rider actually boards, so the trains they
    // must let pass are visible rather than silently cut off.
    const boardIndex = current.candidates.findIndex((candidate) => candidate.departure === current.boarded);
    const shown = current.candidates.slice(0, Math.min(6, boardIndex >= 0 ? Math.max(boardIndex + 1, 3) : 4));

    const options = shown.map(({ departure, arrivalIso: candidateArrival }) => {
      const score = scoreTransfer({ arrivalIso, departureIso: departure.departureTime, walkMinutes: legWalkMinutes });
      const serves = Boolean(candidateArrival);
      return {
        departure: formatClock(departure.departureTime),
        departureIso: departure.departureTime,
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
      arriveIso: arrivalIso,
      boardAfter: formatClock(arrivalIso ? addMinutes(arrivalIso, legWalkMinutes) : null),
      boardAfterIso: arrivalIso ? addMinutes(arrivalIso, legWalkMinutes) : null,
      walkMinutes: legWalkMinutes,
      walkMeters: current.walkBeforeMeters,
      // Confidence describes the train the plan actually puts you on. Whether the
      // earlier ones were catchable is shown per option, so the headline and the
      // itinerary never contradict each other.
      confidence:
        options.find((option) => option.boarding)?.confidence ??
        options.find((option) => option.serves)?.confidence ??
        null,
      missedFirst: Boolean(options.length && options[0].serves && !options[0].boarding),
      headsign: current.boarded?.headsign ?? null,
      // Spell out the arithmetic behind the badge; a colour chip alone is not
      // something a rider can sanity-check.
      explain: (() => {
        const boarding = options.find((option) => option.boarding);
        if (!arrivalIso || !boarding?.departure) return null;
        const spare = scoreTransfer({
          arrivalIso,
          departureIso: current.boarded?.departureTime,
          walkMinutes: legWalkMinutes
        });
        if (spare.seconds === null) return null;
        const mins = Math.floor(Math.abs(spare.seconds) / 60);
        const how = current.walkBeforeMeters !== null ? `walk ${current.walkBeforeMeters} m (${legWalkMinutes} min)` : `walk ${legWalkMinutes} min`;
        return `You arrive ${formatClock(arrivalIso)}, ${how}, and it leaves ${boarding.departure} — ${mins} min to spare.`;
      })(),
      options
    });
  }

  // Journey legs with raw timestamps: the client uses these to track which part of
  // the trip the rider is actually in right now.
  const journeyLegs = legs.map((leg, index) => {
    const ride = trip.rides[index];
    const route = network.routeById[leg.routeId];
    const walkBefore =
      index === 0
        ? null
        : {
            minutes: leg.walkBeforeMinutes,
            meters: leg.walkBeforeMeters,
            // Street walks come from real coordinates; in-station ones are the
            // rider's own setting, because platforms share a single coordinate.
            derived: leg.walkBeforeMeters !== null
          };
    return {
      index,
      routeId: leg.routeId,
      routeName: routeLabel(route, leg.routeId),
      routeShortName: route?.shortName ?? leg.routeId,
      routeColor: route?.color ?? "#64748b",
      fromName: network.stationById[leg.fromId].name,
      toName: network.stationById[leg.toId].name,
      headsign: leg.boarded?.headsign ?? null,
      boardIso: leg.boarded?.departureTime ?? null,
      arriveIso: leg.arrivalIso,
      boardAt: formatClock(leg.boarded?.departureTime ?? null),
      arriveAt: formatClock(leg.arrivalIso),
      mode: route?.mode ?? "subway",
      stops: Math.max(1, ride.stations.length - 1),
      walkBefore,
      walkMinutesAfter: legs[index + 1]?.walkBeforeMinutes ?? null
    };
  });

  const confidence = worstConfidence(liveConnections.map((c) => c.confidence));
  const tightest = liveConnections.reduce<{ seconds: number | null; at: string | null }>(
    (acc, connection, index) => {
      const score = scoreTransfer({
        arrivalIso: legs[index].arrivalIso,
        departureIso: legs[index + 1]?.boarded?.departureTime,
        walkMinutes: legs[index + 1]?.walkBeforeMinutes ?? walkMinutes
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
    departIso,
    arriveAt: formatClock(arriveIso),
    arriveIso,
    duration: formatDuration(departIso, arriveIso),
    generatedAt: new Date().toISOString(),
    nextDeparture: formatClock(legs[1]?.boarded?.departureTime ?? departIso),
    liveStatus: firstLeg.boarded.status,
    transferCount: trip.rides.length - 1,
    // Stops actually ridden through, summed across legs.
    totalStops: journeyLegs.reduce((sum, leg) => sum + leg.stops, 0),
    dataSource: sources.has("prediction") ? (sources.size > 1 ? "mixed" : "prediction") : "schedule",
    incomplete,
    notes,
    legs: journeyLegs,
    alerts,
    rerouted,
    walkMinutes,
    whatIf: { departShiftMinutes, delayMinutes },
    // Colour travels with the shape: the client only holds the subway palette, and
    // a trip can now include any of 149 bus routes.
    geometry: trip.segments.map((segment) =>
      segment.kind === "ride"
        ? {
            kind: "ride" as const,
            routeId: segment.ride.routeId,
            color: network.routeById[segment.ride.routeId]?.color ?? "#64748b",
            points: segment.ride.stations.map((station) => [station.lat, station.lon] as [number, number])
          }
        : {
            kind: "walk" as const,
            routeId: null,
            color: "#64748b",
            points: [
              [segment.walk.from.lat, segment.walk.from.lon] as [number, number],
              [segment.walk.to.lat, segment.walk.to.lon] as [number, number]
            ]
          }
    ),
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
