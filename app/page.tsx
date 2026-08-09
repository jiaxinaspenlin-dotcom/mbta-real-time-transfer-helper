"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import StationPicker from "@/components/StationPicker";

const RouteMap = dynamic(() => import("@/components/RouteMap"), {
  ssr: false,
  loading: () => <div className="mapCanvas mapCanvasLoading">Loading map…</div>
});

type LineRoute = { id: string; name: string; shortName: string; color: string; textColor: string };
type Station = { id: string; name: string; lat: number; lon: number; routeIds: string[] };
type Shape = { routeId: string; points: [number, number][] };
type NetworkData = { routes: LineRoute[]; stations: Station[]; geometry: Shape[] };

type Direction = {
  id: string;
  kind: "ride" | "transfer";
  title: string;
  detail: string;
  routeId: string | null;
  confidence: string | null;
  badge: string | null;
  atIso: string | null;
};

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
  walkMinutes: number;
  whatIf: { departShiftMinutes: number; delayMinutes: number };
  directions: Direction[];
  geometry: Shape[];
  markers: Array<{ kind: "board" | "transfer" | "arrive"; name: string; lat: number; lon: number }>;
  liveConnections: LiveConnection[];
};

type Suggestion = { stationId: string; stationName: string; routeIds: string[]; reason: string };

type MobileView = "plan" | "map" | "trip";

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function confidenceClass(label: string | null) {
  if (!label) return "conf conf-unknown";
  return `conf conf-${label.toLowerCase()}`;
}

/** "in 4 min" beats "6:39 AM" when you are standing on the platform. */
function countdown(iso: string | null, now: number) {
  if (!iso) return null;
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds < -90) return null;
  if (seconds < 30) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function agoLabel(iso: string | null, now: number) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ago`;
}

const REFRESH_MS = 60_000;
const TICK_MS = 10_000;

export default function HomePage() {
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);

  const [originId, setOriginId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  // Commuters overwhelmingly want "now"; a fixed time is the exception.
  const [leaveNow, setLeaveNow] = useState(true);
  const [departAt, setDepartAt] = useState(nowLocal);
  const [now, setNow] = useState(() => Date.now());
  const [walkMinutes, setWalkMinutes] = useState(3);
  const [departShiftMinutes, setDepartShiftMinutes] = useState(0);
  const [delayMinutes, setDelayMinutes] = useState(0);

  const [result, setResult] = useState<PlanResult | null>(null);
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [assistOpen, setAssistOpen] = useState(false);
  const [assistText, setAssistText] = useState("");
  const [assistStatus, setAssistStatus] = useState<"idle" | "loading">("idle");
  const [assistError, setAssistError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [mobileView, setMobileView] = useState<MobileView>("plan");
  const hasPlanned = useRef(false);
  const requestId = useRef(0);

  useEffect(() => {
    let active = true;
    fetch("/api/network")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not load the MBTA network.");
        return json as NetworkData;
      })
      .then((data) => {
        if (active) setNetwork(data);
      })
      .catch((err) => {
        if (active) setNetworkError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);

  const routeById = useMemo(
    () => Object.fromEntries((network?.routes ?? []).map((route) => [route.id, route])),
    [network]
  );

  const runPlan = useCallback(
    async (overrides?: { departShiftMinutes?: number; delayMinutes?: number; silent?: boolean }) => {
      if (!originId || !destinationId) {
        setError("Choose where you are boarding and where you are heading.");
        return;
      }
      const id = ++requestId.current;
      // A background refresh must not make the button flicker every minute.
      if (overrides?.silent) setRefreshing(true);
      else setStatus("loading");
      setError(null);

      try {
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Null lets the server use its own clock, which keeps auto-refresh
            // meaningful instead of re-planning from a frozen timestamp.
            originId,
            destinationId,
            departAt: leaveNow ? null : departAt,
            walkMinutes,
            departShiftMinutes: overrides?.departShiftMinutes ?? departShiftMinutes,
            delayMinutes: overrides?.delayMinutes ?? delayMinutes
          })
        });
        const json = await res.json();
        if (id !== requestId.current) return;
        setStatus("idle");
        setRefreshing(false);
        if (!res.ok) {
          setError(json.error ?? "Unable to plan this trip.");
          return;
        }
        setResult(json);
        setNow(Date.now());
        if (!hasPlanned.current) setMobileView("trip");
        hasPlanned.current = true;
      } catch {
        if (id !== requestId.current) return;
        setStatus("idle");
        setRefreshing(false);
        setError("Could not reach the planner. Check your connection and try again.");
      }
    },
    [originId, destinationId, leaveNow, departAt, walkMinutes, departShiftMinutes, delayMinutes]
  );

  // Countdowns tick without refetching.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Live data goes stale fast, so refresh in the background while a trip is shown.
  // Paused when the tab is hidden and when a fixed departure time is pinned.
  useEffect(() => {
    if (!result || !leaveNow) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void runPlan({ silent: true });
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [result, leaveNow, runPlan]);

  // What-if knobs re-run the plan on their own once a trip exists.
  useEffect(() => {
    if (!hasPlanned.current) return;
    const timer = setTimeout(() => {
      void runPlan();
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departShiftMinutes, delayMinutes, walkMinutes]);

  const onSwap = useCallback(() => {
    setOriginId(destinationId);
    setDestinationId(originId);
  }, [originId, destinationId]);

  const onReset = useCallback(() => {
    setResult(null);
    setError(null);
    setDepartShiftMinutes(0);
    setDelayMinutes(0);
    hasPlanned.current = false;
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
      if (!json.suggestions?.length) {
        setAssistError("No station in the MBTA network matched that description.");
      }
    } catch {
      setAssistStatus("idle");
      setAssistError("Station assist is unavailable.");
    }
  }

  const planned = Boolean(result);
  const step = planned ? 3 : originId && destinationId ? 2 : 1;
  const whatIfActive = departShiftMinutes > 0 || delayMinutes > 0;

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

      <ol className="stepper" aria-label="How to use this planner">
        {(
          [
            ["Pick your stations", "Stations"],
            ["Plan the trip", "Plan"],
            ["Check your transfers", "Transfers"]
          ] as Array<[string, string]>
        ).map(([full, short], index) => (
          <li key={full} className={step >= index + 1 ? "on" : ""}>
            <b>{index + 1}</b>
            <span className="stepFull">{full}</span>
            <span className="stepShort">{short}</span>
          </li>
        ))}
      </ol>

      <div className="workspace">
        <section className={`col colPlan ${mobileView === "plan" ? "activeView" : ""}`} aria-label="Trip setup">
          <div className="card">
            <div className="cardHead">
              <h2>Your trip</h2>
              <button className="ghostButton" type="button" onClick={onSwap} disabled={!originId && !destinationId}>
                ⇅ Swap
              </button>
            </div>

            <StationPicker
              label="Board at"
              value={originId}
              stations={network.stations}
              routeById={routeById}
              onChange={setOriginId}
            />

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

            <p className="hint">Or tap any station on the map to set it as your start or destination.</p>

            <div className="field">
              <span>Leaving</span>
              <div className="segmented" role="group" aria-label="Departure time">
                <button
                  type="button"
                  className={leaveNow ? "on" : ""}
                  aria-pressed={leaveNow}
                  onClick={() => setLeaveNow(true)}
                >
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

            <div className="field">
              <span>
                Your platform-to-platform walk <b>{walkMinutes} min</b>
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
                <span>1 min · fast walker</span>
                <span>15 min · taking it slow</span>
              </div>
              <p className="hint">
                Your setting, not our estimate — the MBTA publishes no platform walking distances.
              </p>
            </div>

            {error ? <div className="errorBox">{error}</div> : null}

            <div className="actions plannerActions">
              <button className="ghostButton" type="button" onClick={onReset}>
                Reset
              </button>
              <button className="primaryButton" type="button" onClick={() => void runPlan()} disabled={status === "loading"}>
                {status === "loading" ? "Checking MBTA…" : planned ? "Refresh trip" : "Plan trip"}
              </button>
            </div>
          </div>

          <div className={`card whatIfCard ${whatIfActive ? "armed" : ""}`}>
            <div className="cardHead">
              <h2>What if…</h2>
              {whatIfActive ? (
                <button
                  className="ghostButton"
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
            <p className="hint">Simulate a later start or a late train. The trip re-plans against live MBTA data.</p>

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
                disabled={!planned}
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
                disabled={!planned}
              />
            </div>

            {!planned ? <p className="hint">Plan a trip first to use these.</p> : null}
          </div>
        </section>

        <section className={`col colMap ${mobileView === "map" ? "activeView" : ""}`} aria-label="Route map">
          <div className="card mapShell">
            <div className="cardHead">
              <h2>{planned ? "Your route" : "The network"}</h2>
              <span className="badge">{planned ? "Trip highlighted" : "Tap a station"}</span>
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
          <div className="card summaryCard">
            {planned && result ? (
              <>
                <div className="summaryHead">
                  <div>
                    <h2>{result.title}</h2>
                    <p className="mutedText">{result.subtitle}</p>
                  </div>
                  <span className={confidenceClass(result.confidence)}>
                    {result.confidence ?? (result.transferCount === 0 ? "No transfer" : "Unknown")}
                  </span>
                </div>

                <div className="metrics">
                  <div className="leadMetric">
                    <span>Depart</span>
                    <strong>{result.departAt ?? "—"}</strong>
                    {countdown(result.departIso, now) ? (
                      <em className="countdown">{countdown(result.departIso, now)}</em>
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
                  {result.liveStatus ? <span className="statusTag">{result.liveStatus}</span> : null}
                  {whatIfActive ? <span className="statusTag simTag">Simulated scenario</span> : null}
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
              </>
            ) : (
              <div className="empty">
                <h2>No trip yet</h2>
                <p className="mutedText">
                  Pick a start and destination, then press <b>Plan trip</b>. Everything shown here comes straight
                  from the MBTA API.
                </p>
              </div>
            )}
          </div>

          {planned && result ? (
            <>
              <div className="card">
                <div className="cardHead">
                  <h2>Step by step</h2>
                </div>
                <ol className="steps">
                  {result.directions.map((direction, index) => (
                    <li
                      key={direction.id}
                      className={direction.kind === "transfer" ? "stepItem transferStep" : "stepItem"}
                      style={{
                        borderLeftColor: direction.routeId ? routeById[direction.routeId]?.color : "#94a3b8"
                      }}
                    >
                      <span className="stepIndex">{index + 1}</span>
                      <div className="stepBody">
                        <strong>{direction.title}</strong>
                        <span>{direction.detail}</span>
                      </div>
                      <div className="stepMeta">
                        {direction.badge ? (
                          <span className="badge">
                            {direction.badge}
                            {countdown(direction.atIso, now) ? ` · ${countdown(direction.atIso, now)}` : ""}
                          </span>
                        ) : null}
                        {direction.confidence ? (
                          <span className={confidenceClass(direction.confidence)}>{direction.confidence}</span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="card">
                <div className="cardHead">
                  <h2>Next connections</h2>
                </div>
                {result.liveConnections.length ? (
                  <>
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
                          <p className="connectionTiming">
                            Arrive {connection.arriveAt ?? "—"} · on the platform by{" "}
                            {connection.boardAfter ?? "—"} after your {connection.walkMinutes} min walk
                          </p>
                          {connection.missedFirst ? (
                            <p className="noOptions">
                              You cannot reach the platform in time for the first train — the plan puts you on a
                              later one.
                            </p>
                          ) : null}
                          {!connection.options.length ? (
                            <p className="noOptions">
                              No {routeById[connection.toRouteId]?.name ?? connection.toRouteId} departures are
                              being reported here right now.
                            </p>
                          ) : null}
                          <div className="options">
                            {connection.options.map((option, idx) => (
                              <div
                                key={idx}
                                className={`option${option.boarding ? " boarding" : ""}${
                                  option.serves ? "" : " wrongBranch"
                                }`}
                              >
                                <div className="optionTime">
                                  <strong>
                                    {option.departure ?? "—"}
                                    {countdown(option.departureIso, now) ? (
                                      <em className="countdown">{countdown(option.departureIso, now)}</em>
                                    ) : null}
                                  </strong>
                                  {option.headsign ? <span>toward {option.headsign}</span> : null}
                                </div>
                                <div className="optionMeta">
                                  {option.serves ? (
                                    <>
                                      <span className={confidenceClass(option.confidence)}>
                                        {option.confidence ?? "—"}
                                      </span>
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
                  </>
                ) : (
                  <p className="mutedText">This trip is a straight ride — no transfers to worry about.</p>
                )}
              </div>
            </>
          ) : null}
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
                    <button type="button" onClick={() => setOriginId(item.stationId)}>
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
            {id === "trip" && planned && result?.confidence ? (
              <i className={`dot dot-${result.confidence.toLowerCase()}`} />
            ) : null}
          </button>
        ))}
      </nav>
    </main>
  );
}
