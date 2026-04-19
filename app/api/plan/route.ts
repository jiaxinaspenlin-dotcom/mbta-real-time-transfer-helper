import { NextRequest, NextResponse } from "next/server";
import { buildMarkers, buildRouteGeometry, fetchPrediction, fetchUpcomingPredictions, formatClock, formatMinutes, scoreTransfer, tripSubtitle, addMinutes } from "@/lib/mbta";
import { LINE_LABELS, planTrip } from "@/lib/network";

type LiveOption = {
  departure: string;
  buffer: string;
  status: string;
  liveStatus: string | null;
};

export async function POST(req: NextRequest) {
  const { originId, destinationId, departAt, walkMinutes } = await req.json();
  const trip = planTrip(originId, destinationId);
  if (!trip) {
    return NextResponse.json({ error: "Unable to build a route for those stations." }, { status: 400 });
  }

  const rideSteps = trip.steps.filter((s) => s.kind === "ride" && s.line);
  const firstRide = rideSteps[0];

  let firstDeparture = departAt ? new Date(departAt).toISOString() : new Date().toISOString();
  let firstStatus: string | null = null;
  const liveFirst = await fetchPrediction(firstRide.from.stopId, firstRide.line!);
  if (liveFirst?.departureTime) firstDeparture = liveFirst.departureTime;
  if (liveFirst?.status) firstStatus = liveFirst.status;

  const rideDurations = rideSteps.map((ride) => Math.max(2, (ride.stations.length - 1) * 3));
  const rideDepartures: string[] = [firstDeparture];
  const rideArrivals: string[] = [addMinutes(firstDeparture, rideDurations[0])];
  const liveConnections: Array<{
    id: string;
    transferAt: string;
    connectionLabel: string;
    arriveAt: string;
    boardAfter: string;
    walkMinutes: number;
    options: LiveOption[];
  }> = [];

  for (let i = 1; i < rideSteps.length; i += 1) {
    const incomingRide = rideSteps[i - 1];
    const outgoingRide = rideSteps[i];
    const arrivalIso = rideArrivals[i - 1];
    const boardAfterIso = addMinutes(arrivalIso, walkMinutes);

    const upcoming = await fetchUpcomingPredictions(outgoingRide.from.stopId, outgoingRide.line!, 5);
    let boardable = upcoming.filter((item) => item.departureTime && new Date(item.departureTime).getTime() >= new Date(boardAfterIso).getTime());
    if (!boardable.length) boardable = upcoming;

    const primaryDeparture = boardable[0]?.departureTime ?? boardAfterIso;
    const fallbackDeparture = boardable[1]?.departureTime ?? null;

    rideDepartures[i] = primaryDeparture;
    rideArrivals[i] = addMinutes(primaryDeparture, rideDurations[i]);

    const primaryScore = scoreTransfer({ arrivalIso, departureIso: primaryDeparture, walkMinutes });
    const options: LiveOption[] = [{
      departure: formatClock(primaryDeparture),
      buffer: formatMinutes(primaryScore.seconds),
      status: primaryScore.label,
      liveStatus: boardable[0]?.status ?? null
    }];

    if (fallbackDeparture) {
      const fallbackScore = scoreTransfer({ arrivalIso, departureIso: fallbackDeparture, walkMinutes });
      options.push({
        departure: formatClock(fallbackDeparture),
        buffer: formatMinutes(fallbackScore.seconds),
        status: fallbackScore.label,
        liveStatus: boardable[1]?.status ?? null
      });
    }

    liveConnections.push({
      id: `${incomingRide.to.id}-${outgoingRide.line}`,
      transferAt: incomingRide.to.name,
      connectionLabel: `${LINE_LABELS[incomingRide.line!]} → ${LINE_LABELS[outgoingRide.line!]}`,
      arriveAt: formatClock(arrivalIso),
      boardAfter: formatClock(boardAfterIso),
      walkMinutes,
      options
    });
  }

  const secondDeparture = rideDepartures[1] ?? null;
  const score = scoreTransfer({ arrivalIso: rideArrivals[0], departureIso: secondDeparture, walkMinutes });

  const directions = trip.steps.map((step, index) => {
    if (step.kind === "transfer") {
      return {
        id: `transfer-${index}`,
        kind: "transfer",
        title: `Transfer at ${step.from.name}`,
        detail: `Walk between platforms at ${step.from.name}.`,
        line: null,
        badge: `${walkMinutes} min`
      };
    }
    const rideIndex = rideSteps.findIndex((ride) => ride.from.id === step.from.id && ride.to.id === step.to.id && ride.line === step.line);
    return {
      id: `ride-${index}`,
      kind: "ride",
      title: `Board ${step.line?.replace("-", " ")}`,
      detail: `Ride from ${step.from.name} to ${step.to.name}.`,
      line: step.line ?? null,
      badge: formatClock(rideIndex >= 0 ? rideDepartures[rideIndex] : null)
    };
  });

  return NextResponse.json({
    title: `${trip.origin.name} → ${trip.destination.name}`,
    subtitle: tripSubtitle(trip),
    confidence: score.label,
    transferWindow: formatMinutes(score.seconds),
    nextDeparture: secondDeparture ? formatClock(secondDeparture) : formatClock(firstDeparture),
    liveStatus: liveConnections[0]?.options?.[0]?.liveStatus ?? firstStatus,
    departAt: formatClock(firstDeparture),
    transferCount: trip.steps.filter((s) => s.kind === "transfer").length,
    directions,
    geometry: buildRouteGeometry(trip),
    markers: buildMarkers(trip),
    liveConnections
  });
}
