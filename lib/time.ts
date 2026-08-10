/** Client-safe time formatting. Kept out of lib/mbta.ts so it carries no server imports. */

/** "in 4 min" beats "6:39 AM" when you are standing on the platform. */
export function countdown(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds < -90) return null;
  if (seconds < 30) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Bare "4 min" with no preposition, for use inside a sentence. */
export function minutesUntil(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  return Math.max(0, Math.round(seconds / 60));
}

export function agoLabel(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

export type JourneyLeg = {
  index: number;
  routeId: string;
  routeName: string;
  routeShortName: string;
  routeColor: string;
  fromName: string;
  toName: string;
  headsign: string | null;
  boardIso: string | null;
  arriveIso: string | null;
  boardAt: string | null;
  arriveAt: string | null;
  mode: "subway" | "bus";
  stops: number;
  /** Null on the first leg. `derived` means it came from real coordinates. */
  walkBefore: { minutes: number; meters: number | null; derived: boolean } | null;
  walkMinutesAfter: number | null;
};

export type JourneyState =
  | { phase: "toBoard"; leg: JourneyLeg }
  | { phase: "riding"; leg: JourneyLeg }
  | { phase: "transfer"; leg: JourneyLeg; previous: JourneyLeg }
  | { phase: "arrived" }
  | null;

/**
 * Which part of the trip the rider is actually in, derived purely from the leg
 * timestamps. This is what lets the interface advance instead of showing one
 * static itinerary for the whole journey.
 */
export function journeyState(legs: JourneyLeg[], now: number): JourneyState {
  if (!legs.length) return null;

  const last = legs[legs.length - 1];
  if (last.arriveIso && now >= new Date(last.arriveIso).getTime()) return { phase: "arrived" };

  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (leg.boardIso && now < new Date(leg.boardIso).getTime()) {
      return i === 0 ? { phase: "toBoard", leg } : { phase: "transfer", leg, previous: legs[i - 1] };
    }
    if (leg.arriveIso && now < new Date(leg.arriveIso).getTime()) {
      return { phase: "riding", leg };
    }
  }
  return { phase: "arrived" };
}

/** 0..1 progress through the whole trip, for the progress rail. */
export function journeyProgress(legs: JourneyLeg[], now: number) {
  const start = legs[0]?.boardIso;
  const end = legs[legs.length - 1]?.arriveIso;
  if (!start || !end) return 0;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (b <= a) return 0;
  return Math.min(1, Math.max(0, (now - a) / (b - a)));
}
