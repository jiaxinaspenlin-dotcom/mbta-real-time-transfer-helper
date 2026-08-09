"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import StationPicker from "@/components/StationPicker";
import NowCard from "@/components/NowCard";
import Timeline from "@/components/Timeline";
import { JourneyLeg, agoLabel, countdown, journeyState } from "@/lib/time";

const RouteMap = dynamic(() => import("@/components/RouteMap"), {
  ssr: false,
  loading: () => <div className="mapCanvas mapCanvasLoading">Loading map…</div>
});

type LineRoute = { id: string; name: string; shortName: string; color: string; textColor: string };
type Station = { id: string; name: string; lat: number; lon: number; routeIds: string[] };
type Shape = { routeId: string; points: [number, number][] };
type NetworkData = { routes: LineRoute[]; stations: Station[]; geometry: Shape[] };

type ServiceAlert = { id: string; header: string; effect: string; severity: number; routeNames: string[] };

type ConnectionOption = {
  departure: string | null;
  departureIso: string | null;
  headsign: string | null;
  buffer: string | null;
  confidence: string | null;
  source: "prediction" | "schedule";
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
  confidence: string | null;
  missedFirst: boolean;
  headsign: string | null;
  explain: string | null;
  options: ConnectionOption[];
};

type PlanResult = {
  title: string;
  subtitle: string;
  confidence: string | null;
  transferWindow: string | null;
  tightestAt: string | null;
  departAt: string | null;
  departIso: string | null;
  arriveAt: string | null;
  arriveIso: string | null;
  duration: string | null;
  generatedAt: string;
  nextDeparture: string | null;
  liveStatus: string | null;
  transferCount: number;
  dataSource: "prediction" | "schedule" | "mixed";
  incomplete: boolean;
  notes: string[];
  legs: JourneyLeg[];
  alerts: ServiceAlert[];
  walkMinutes: number;
  whatIf: { departShiftMinutes: number; delayMinutes: number };
  geometry: Shape[];
  markers: Array<{ kind: "board" | "transfer" | "arrive"; name: string; lat: number; lon: number }>;
  liveConnections: LiveConnection[];
};

type Suggestion = { stationId: string; stationName: string; routeIds: string[]; reason: string };
type MobileView = "plan" | "map" | "trip";

const REFRESH_MS = 60_000;
const TICK_MS = 10_000;
const STALE_AFTER_MS = 100_000;
const DEFAULT_WALK = 3;

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function confidenceClass(label: string | null) {
  return label ? `conf conf-${label.toLowerCase()}` : "conf conf-unknown";
}

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const EFFECT_LABELS: Record<string, string> = {
  SUSPENSION: "Suspended",
  STATION_CLOSURE: "Station closed",
  SHUTTLE: "Shuttle bus",
  DELAY: "Delays",
  DETOUR: "Detour",
  STATION_ISSUE: "Station issue",
  SERVICE_CHANGE: "Service change"
};

export default function HomePage() {
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);

  const [originId, setOriginId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [leaveNow, setLeaveNow] = useState(true);
  const [departAt, setDepartAt] = useState(nowLocal);
  const [walkMinutes, setWalkMinutes] = useState(DEFAULT_WALK);
  const [departShiftMinutes, setDepartShiftMinutes] = useState(0);
  const [delayMinutes, setDelayMinutes] = useState(0);

  const [result, setResult] = useState<PlanResult | null>(null);
  const [baseline, setBaseline] = useState<PlanResult | null>(null);
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAlerts, setErrorAlerts] = useState<ServiceAlert[]>([]);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const [assistOpen, setAssistOpen] = useState(false);
  const [assistText, setAssistText] = useState("");
  const [assistStatus, setAssistStatus] = useState<"idle" | "loading">("idle");
  const [assistError, setAssistError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [mobileView, setMobileView] = useState<MobileView>("plan");
  const [now, setNow] = useState(() => Date.now());
  const requestId = useRef(0);

  // Deep link in. Read before the network arrives; the API validates the ids.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    const to = params.get("to");
    const walk = Number(params.get("walk"));
    if (from) setOriginId(from);
    if (to) setDestinationId(to);
    if (Number.isFinite(walk) && walk >= 1 && walk <= 15) setWalkMinutes(Math.round(walk));
  }, []);

  // Deep link out, so a trip can be bookmarked or shared without any storage.
  useEffect(() => {
    const params = new URLSearchParams();
    if (originId) params.set("from", originId);
    if (destinationId) params.set("to", destinationId);
    if (walkMinutes !== DEFAULT_WALK) params.set("walk", String(walkMinutes));
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, [originId, destinationId, walkMinutes]);

  useEffect(() => {
    let active = true;
    fetch("/api/network")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not load the MBTA network.");
        return json as NetworkData;
      })
      .then((data) => active && setNetwork(data))
      .catch((err) => active && setNetworkError(err.message));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const routeById = useMemo(
    () => Object.fromEntries((network?.routes ?? []).map((route) => [route.id, route])),
    [network]
  );

  const runPlan = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!originId || !destinationId || originId === destinationId) return;
      const id = ++requestId.current;
      if (options?.silent) setRefreshing(true);
      else setStatus("loading");
      setError(null);
      setErrorAlerts([]);

      try {
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originId,
            destinationId,
            departAt: leaveNow ? null : departAt,
            walkMinutes,
            departShiftMinutes,
            delayMinutes
          })
        });
        const json = await res.json();
        if (id !== requestId.current) return;
        setStatus("idle");
        setRefreshing(false);
        if (!res.ok) {
          setResult(null);
          setError(json.error ?? "Unable to plan this trip.");
          setErrorAlerts(json.alerts ?? []);
          return;
        }
        setResult(json);
        // Keep an unsimulated copy so what-if can be shown as a delta.
        if (!departShiftMinutes && !delayMinutes) setBaseline(json);
        setNow(Date.now());
      } catch {
        if (id !== requestId.current) return;
        setStatus("idle");
        setRefreshing(false);
        setError("Could not reach the planner. Check your connection and try again.");
      }
    },
    [originId, destinationId, leaveNow, departAt, walkMinutes, departShiftMinutes, delayMinutes]
  );

  // Once both stations are known the app has everything it needs, so planning is
  // automatic. The button below is a refresh, not a gate.
  useEffect(() => {
    if (!originId || !destinationId || originId === destinationId) return;
    const timer = setTimeout(() => void runPlan(), 350);
    return () => clearTimeout(timer);
  }, [originId, destinationId, walkMinutes, leaveNow, departAt, departShiftMinutes, delayMinutes, runPlan]);

  useEffect(() => {
    if (!result || !leaveNow) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void runPlan({ silent: true });
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [result, leaveNow, runPlan]);

  const useMyLocation = useCallback(() => {
    if (!network) return;
    if (!navigator.geolocation) {
      setLocationError("This browser cannot share your location.");
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const nearest = network.stations.reduce((best, station) => {
          const d = distanceKm(latitude, longitude, station.lat, station.lon);
          return !best || d < best.d ? { station, d } : best;
        }, null as { station: Station; d: number } | null);
        setLocating(false);
        if (nearest) setOriginId(nearest.station.id);
        else setLocationError("No MBTA station found near you.");
      },
      () => {
        setLocating(false);
        setLocationError("Could not get your location. Pick a station instead.");
      },
      { timeout: 8000, maximumAge: 60_000 }
    );
  }, [network]);

  const onSwap = useCallback(() => {
    setOriginId(destinationId);
    setDestinationId(originId);
  }, [originId, destinationId]);

  const onReset = useCallback(() => {
    setResult(null);
    setBaseline(null);
    setError(null);
    setErrorAlerts([]);
    setOriginId("");
    setDestinationId("");
    setDepartShiftMinutes(0);
    setDelayMinutes(0);
    setLeaveNow(true);
    setMobileView("plan");
  }, []);

  const onMapSelect = useCallback((stationId: string, role: "origin" | "destination") => {
    if (role === "origin") setOriginId(stationId);
    else setDestinationId(stationId);
  }, []);

  async function onSuggestStations() {
    if (!assistText.trim()) return;
    setAssistStatus("loading");
    setAssistError(null);
    setSuggestions([]);
    try {
      const res = await fetch("/api/station-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: assistText })
      });
      const json = await res.json();
      setAssistStatus("idle");
      if (!res.ok) {
        setAssistError(json.error ?? "Station assist is unavailable.");
        return;
      }
      setSuggestions(json.suggestions ?? []);
      if (!json.suggestions?.length) setAssistError("No station in the MBTA network matched that description.");
    } catch {
      setAssistStatus("idle");
      setAssistError("Station assist is unavailable.");
    }
  }

  const planned = Boolean(result);
  const bothChosen = Boolean(originId && destinationId && originId !== destinationId);
  const whatIfActive = departShiftMinutes > 0 || delayMinutes > 0;
  const journey = result ? journeyState(result.legs, now) : null;
  const riding = journey ? journey.phase !== "toBoard" : false;
  const stale = result ? now - new Date(result.generatedAt).getTime() > STALE_AFTER_MS : false;
  const step = !bothChosen ? 1 : riding ? 3 : 2;

  if (networkError) {
    return (
      <main className="bootScreen">
        <div className="bootCard">
          <h1>MBTA data unavailable</h1>
          <p>{networkError}</p>
          <p className="mutedText">
            This app shows only real MBTA data, so it will not display a route until the API responds.
          </p>
          <button className="primaryButton" type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (!network) {
    return (
      <main className="bootScreen">
        <div className="bootCard">
          <div className="spinner" aria-hidden />
          <h1>Loading the MBTA network…</h1>
          <p className="mutedText">Fetching live routes and stations from the MBTA API.</p>
        </div>
      </main>
    );
  }

  const alerts = result?.alerts ?? errorAlerts;

  const alertsCard = alerts.length ? (
    <div className="card alertCard">
      <div className="cardHead">
        <h2>Service alerts</h2>
      </div>
      {alerts.map((alert) => (
        <div key={alert.id} className="alertItem">
          <span className="alertEffect">{EFFECT_LABELS[alert.effect] ?? alert.effect.replace(/_/g, " ")}</span>
          <p>{alert.header}</p>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <main className="app">
      <header className="topBar">
        <div className="brand">
          {/* Two routes meeting at a station node: the transfer this app is about. */}
          <span className="brandMark" aria-hidden>
            <svg viewBox="0 0 64 64" focusable="false">
              <rect width="64" height="64" rx="14" fill="#101c2e" />
              <path d="M32 23V45" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" opacity="0.55" />
              <path d="M9 23h46" stroke="#ED8B00" strokeWidth="9" strokeLinecap="round" />
              <path d="M9 45h46" stroke="#DA291C" strokeWidth="9" strokeLinecap="round" />
              <circle cx="32" cy="23" r="5.5" fill="#ffffff" />
              <circle cx="32" cy="45" r="5.5" fill="#ffffff" />
            </svg>
          </span>
          <div>
            <h1>MBTA Transfer Helper</h1>
            <p>Live connections, transfer confidence, and what-if planning</p>
          </div>
        </div>
        <div className="lineKey">
          {network.routes.map((route) => (
            <span key={route.id} className="lineChip" style={{ background: route.color, color: route.textColor }}>
              {route.shortName}
            </span>
          ))}
        </div>
      </header>

      <ol className="stepper" aria-label="Where you are in the trip">
        {(
          [
            ["Pick your stations", "Stations"],
            ["Check your transfers", "Transfers"],
            ["Ride it", "Ride"]
          ] as Array<[string, string]>
        ).map(([full, short], index) => (
          <li key={full} className={step >= index + 1 ? "on" : ""}>
            <b>{index + 1}</b>
            <span className="stepFull">{full}</span>
            <span className="stepShort">{short}</span>
          </li>
        ))}
      </ol>

      {planned && result ? (
        <button
          type="button"
          className="tripStrip"
          onClick={() => setMobileView(mobileView === "trip" ? "plan" : "trip")}
        >
          <span className="tripStripRoute">
            <strong>{result.title}</strong>
            <span>
              {result.departAt} → {result.arriveAt ?? "—"} · {result.duration ?? "—"}
            </span>
          </span>
          <span className={confidenceClass(result.confidence)}>
            {result.confidence ?? (result.transferCount === 0 ? "Direct" : "—")}
          </span>
        </button>
      ) : null}

      <div className="workspace">
        <section className={`col colPlan ${mobileView === "plan" ? "activeView" : ""}`} aria-label="Trip setup">
          <div className="card">
            <div className="cardHead">
              <h2>{originId ? "Your trip" : "Where to?"}</h2>
              {bothChosen ? (
                <button className="ghostButton" type="button" onClick={onSwap}>
                  ⇅ Swap
                </button>
              ) : null}
            </div>

            <StationPicker
              label="Board at"
              value={originId}
              stations={network.stations}
              routeById={routeById}
              onChange={setOriginId}
            />

            <div className="pickRow">
              <button className="ghostButton small" type="button" onClick={useMyLocation} disabled={locating}>
                {locating ? "Locating…" : "◎ Nearest to me"}
              </button>
              <button className="ghostButton small mapOnly" type="button" onClick={() => setMobileView("map")}>
                Choose on map
              </button>
            </div>
            {locationError ? <p className="hint">{locationError}</p> : null}

            <StationPicker
              label="Head to"
              value={destinationId}
              stations={network.stations}
              routeById={routeById}
              onChange={setDestinationId}
            />

            <button type="button" className="assistTrigger" onClick={() => setAssistOpen(true)}>
              <span aria-hidden>✦</span> Not sure which stop? Describe the place
            </button>

            <div className="field">
              <span>Leaving</span>
              <div className="segmented" role="group" aria-label="Departure time">
                <button type="button" className={leaveNow ? "on" : ""} aria-pressed={leaveNow} onClick={() => setLeaveNow(true)}>
                  Now
                </button>
                <button
                  type="button"
                  className={!leaveNow ? "on" : ""}
                  aria-pressed={!leaveNow}
                  onClick={() => {
                    setDepartAt(nowLocal());
                    setLeaveNow(false);
                  }}
                >
                  At a time
                </button>
              </div>
              {!leaveNow ? (
                <input
                  type="datetime-local"
                  value={departAt}
                  onChange={(e) => setDepartAt(e.target.value)}
                  aria-label="Departure time"
                />
              ) : null}
            </div>

            {error ? (
              <div className="errorBox">
                {error}
                {errorAlerts.length ? <div className="errorWhy">See the service alerts below for why.</div> : null}
              </div>
            ) : null}

            {!bothChosen ? (
              <p className="hint">
                Pick both stations and the trip plans itself — no button needed.
              </p>
            ) : (
              <div className="actions plannerActions">
                <button className="primaryButton" type="button" onClick={() => void runPlan()} disabled={status === "loading"}>
                  {status === "loading" ? "Checking MBTA…" : "Refresh"}
                </button>
                <button className="linkButton" type="button" onClick={onReset}>
                  Start over
                </button>
              </div>
            )}
          </div>

          {/* Refinements only appear once there is an answer to refine. */}
          {planned ? (
            <>
              <div className="card">
                <div className="cardHead">
                  <h2>Your walking pace</h2>
                </div>
                <div className="field">
                  <span>
                    Platform-to-platform walk <b>{walkMinutes} min</b>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={15}
                    step={1}
                    value={walkMinutes}
                    onChange={(e) => setWalkMinutes(Number(e.target.value))}
                    aria-label="Minutes you need to walk between platforms"
                  />
                  <div className="rangeEnds">
                    <span>1 min · fast</span>
                    <span>15 min · slow</span>
                  </div>
                  <p className="hint">Your setting, not our estimate — the MBTA publishes no platform distances.</p>
                </div>
              </div>

              <div className={`card whatIfCard ${whatIfActive ? "armed" : ""}`}>
                <div className="cardHead">
                  <h2>What if…</h2>
                  {whatIfActive ? (
                    <button
                      className="ghostButton small"
                      type="button"
                      onClick={() => {
                        setDepartShiftMinutes(0);
                        setDelayMinutes(0);
                      }}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>

                <div className="field">
                  <span>
                    I leave <b>{departShiftMinutes} min</b> later
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={5}
                    value={departShiftMinutes}
                    onChange={(e) => setDepartShiftMinutes(Number(e.target.value))}
                  />
                </div>

                <div className="field">
                  <span>
                    My train runs <b>{delayMinutes} min</b> late
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={30}
                    step={1}
                    value={delayMinutes}
                    onChange={(e) => setDelayMinutes(Number(e.target.value))}
                  />
                </div>

                {whatIfActive && baseline && result ? (
                  <div className="delta">
                    <div>
                      <span>Confidence</span>
                      <strong>
                        <em className={confidenceClass(baseline.confidence)}>{baseline.confidence ?? "—"}</em>
                        {" → "}
                        <em className={confidenceClass(result.confidence)}>{result.confidence ?? "—"}</em>
                      </strong>
                    </div>
                    <div>
                      <span>Arrive</span>
                      <strong>
                        {baseline.arriveAt ?? "—"} → {result.arriveAt ?? "—"}
                      </strong>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </section>

        <section className={`col colMap ${mobileView === "map" ? "activeView" : ""}`} aria-label="Route map">
          <div className="card mapShell">
            <div className="cardHead">
              <h2>{planned ? "Your route" : "The network"}</h2>
              <span className="badge">
                {!originId ? "Tap a station to start" : !destinationId ? "Now tap your destination" : "Trip highlighted"}
              </span>
            </div>
            <RouteMap
              routes={network.routes}
              network={network.geometry}
              stations={network.stations}
              trip={result?.geometry ?? []}
              markers={result?.markers ?? []}
              originId={originId}
              destinationId={destinationId}
              onSelect={onMapSelect}
            />
          </div>
        </section>

        <section className={`col colTrip ${mobileView === "trip" ? "activeView" : ""}`} aria-label="Trip results">
          {planned && result ? (
            <>
              <NowCard
                legs={result.legs}
                connections={result.liveConnections}
                destinationName={result.legs[result.legs.length - 1]?.toName ?? ""}
                now={now}
                onReturnTrip={onSwap}
              />

              {alertsCard}

              <div className="card summaryCard">
                <div className="metrics">
                  <div className="leadMetric">
                    <span>Depart</span>
                    <strong>{result.departAt ?? "—"}</strong>
                    {countdown(result.departIso, now) ? (
                      <em className={`countdown${stale ? " stale" : ""}`}>{countdown(result.departIso, now)}</em>
                    ) : null}
                  </div>
                  <div>
                    <span>Arrive</span>
                    <strong>{result.arriveAt ?? "—"}</strong>
                  </div>
                  <div>
                    <span>Duration</span>
                    <strong>{result.duration ?? "—"}</strong>
                  </div>
                  <div>
                    <span>Transfers</span>
                    <strong>{result.transferCount}</strong>
                  </div>
                </div>

                {result.transferCount > 0 ? (
                  <div className="tightest">
                    Tightest transfer{result.tightestAt ? ` at ${result.tightestAt}` : ""}:{" "}
                    <b>{result.transferWindow ?? "unknown"}</b> of slack after your walk
                  </div>
                ) : null}

                <div className="sourceRow">
                  <span className={`sourceTag ${result.dataSource}`}>
                    {result.dataSource === "prediction"
                      ? "Live predictions"
                      : result.dataSource === "schedule"
                        ? "Scheduled times"
                        : "Live + scheduled"}
                  </span>
                  {whatIfActive ? <span className="statusTag simTag">Simulated</span> : null}
                  {leaveNow ? (
                    <span className={`statusTag liveTag${refreshing ? " pulsing" : ""}`}>
                      <i className="liveDot" aria-hidden /> Updated {agoLabel(result.generatedAt, now)}
                    </span>
                  ) : null}
                </div>

                {result.notes.length ? (
                  <div className="warnBox">
                    <b>Gaps in the MBTA feed</b>
                    <ul>
                      {result.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="card">
                <div className="cardHead">
                  <h2>The whole trip</h2>
                </div>
                <Timeline legs={result.legs} connections={result.liveConnections} now={now} />
              </div>

              {result.liveConnections.length ? (
                <div className="card">
                  <div className="cardHead">
                    <h2>Next connections</h2>
                  </div>
                  <div className="legend">
                    <span className="conf conf-likely">Likely</span> 3+ min spare
                    <span className="conf conf-risky">Risky</span> under 3 min
                    <span className="conf conf-unlikely">Unlikely</span> leaves before you arrive
                  </div>
                  <div className="connections">
                    {result.liveConnections.map((connection) => (
                      <div key={connection.id} className="connection">
                        <div className="connectionHead">
                          <div>
                            <strong>{connection.transferAt}</strong>
                            <span className="routeHop">
                              <i style={{ background: routeById[connection.fromRouteId]?.color }} />
                              {routeById[connection.fromRouteId]?.shortName}
                              {" → "}
                              <i style={{ background: routeById[connection.toRouteId]?.color }} />
                              {routeById[connection.toRouteId]?.shortName}
                            </span>
                          </div>
                          <span className={confidenceClass(connection.confidence)}>
                            {connection.confidence ?? "No data"}
                          </span>
                        </div>

                        {connection.explain ? <p className="explain">{connection.explain}</p> : null}

                        {connection.missedFirst ? (
                          <p className="noOptions">
                            You cannot reach the platform in time for the first train — the plan puts you on a later one.
                          </p>
                        ) : null}

                        {/* The walk slider is the lever that flips this badge, so offer it here. */}
                        {(connection.confidence === "Risky" || connection.confidence === "Unlikely") &&
                        walkMinutes > 1 ? (
                          <button
                            type="button"
                            className="nudge"
                            onClick={() => setWalkMinutes(walkMinutes - 1)}
                          >
                            Could you walk it in {walkMinutes - 1} min? Try it →
                          </button>
                        ) : null}

                        {!connection.options.length ? (
                          <p className="noOptions">
                            No {routeById[connection.toRouteId]?.name ?? connection.toRouteId} departures are being
                            reported here right now.
                          </p>
                        ) : null}

                        <div className="options">
                          {connection.options.map((option, idx) => (
                            <div
                              key={idx}
                              className={`option${option.boarding ? " boarding" : ""}${option.serves ? "" : " wrongBranch"}`}
                            >
                              <div className="optionTime">
                                <strong>
                                  {option.departure ?? "—"}
                                  {countdown(option.departureIso, now) ? (
                                    <em className={`countdown${stale ? " stale" : ""}`}>
                                      {countdown(option.departureIso, now)}
                                    </em>
                                  ) : null}
                                </strong>
                                {option.headsign ? <span>toward {option.headsign}</span> : null}
                              </div>
                              <div className="optionMeta">
                                {option.serves ? (
                                  <>
                                    <span className={confidenceClass(option.confidence)}>{option.confidence ?? "—"}</span>
                                    <span className="buffer">{option.buffer ?? "—"}</span>
                                  </>
                                ) : (
                                  <span className="conf conf-unknown">Wrong branch</span>
                                )}
                              </div>
                              {option.boarding ? <span className="boardFlag">You board this</span> : null}
                              {option.note ? <span className="optionNote">{option.note}</span> : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {alertsCard}
              <div className="card">
                <div className="empty">
                  <h2>{bothChosen ? "Planning…" : "Your trip will appear here"}</h2>
                  <p className="mutedText">
                    {bothChosen
                      ? "Checking live MBTA departures."
                      : "Choose where you are and where you are going. You will get the next departures, how likely each transfer is, and a step that updates as you travel."}
                  </p>
                  {!bothChosen ? (
                    <ul className="teaser">
                      <li>Live departures, not a timetable guess</li>
                      <li>Likely / Risky / Unlikely for every transfer</li>
                      <li>Follows along once you are moving</li>
                    </ul>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {assistOpen ? (
        <>
          <div className="assistScrim" onClick={() => setAssistOpen(false)} aria-hidden />
          <div className="assistPanel" role="dialog" aria-modal="true" aria-label="Station assist">
            <div className="cardHead">
              <h2>Find the right stop</h2>
              <button className="ghostButton" type="button" onClick={() => setAssistOpen(false)}>
                Close
              </button>
            </div>
            <p className="hint">Describe where you are going and OpenAI will match it to real MBTA stations.</p>
            <textarea
              value={assistText}
              onChange={(e) => setAssistText(e.target.value)}
              placeholder="TD Garden, the aquarium, Fenway…"
              rows={3}
            />
            <button
              className="primaryButton fullWidth"
              type="button"
              onClick={onSuggestStations}
              disabled={assistStatus === "loading"}
            >
              {assistStatus === "loading" ? "Asking…" : "Suggest stations"}
            </button>
            {assistError ? <div className="errorBox">{assistError}</div> : null}
            {suggestions.length ? (
              <div className="suggestions">
                {suggestions.map((item) => (
                  <div key={item.stationId} className="suggestion">
                    <div>
                      <strong>{item.stationName}</strong>
                      {item.reason ? <span>{item.reason}</span> : null}
                    </div>
                    <div className="suggestionActions">
                      <button
                        type="button"
                        onClick={() => {
                          setOriginId(item.stationId);
                          setAssistOpen(false);
                        }}
                      >
                        Start
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDestinationId(item.stationId);
                          setAssistOpen(false);
                        }}
                      >
                        Destination
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <nav className="tabBar" aria-label="Sections">
        {(
          [
            ["plan", "Plan"],
            ["map", "Map"],
            ["trip", "Trip"]
          ] as Array<[MobileView, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={mobileView === id ? "on" : ""}
            aria-current={mobileView === id}
            onClick={() => setMobileView(id)}
          >
            {label}
            {id === "trip" && result?.confidence ? (
              <i className={`dot dot-${result.confidence.toLowerCase()}`} />
            ) : null}
          </button>
        ))}
      </nav>
    </main>
  );
}
