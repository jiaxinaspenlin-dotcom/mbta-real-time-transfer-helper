"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { LINE_COLORS, LINE_LABELS, stationsForSelect } from "@/lib/network";

const RouteMap = dynamic(() => import("@/components/RouteMap"), { ssr: false });

type Direction = {
  id: string;
  kind: "ride" | "transfer";
  title: string;
  detail: string;
  line: keyof typeof LINE_COLORS | null;
  badge: string;
};

type LiveConnection = {
  id: string;
  transferAt: string;
  connectionLabel: string;
  arriveAt: string;
  boardAfter: string;
  walkMinutes: number;
  options: Array<{
    departure: string;
    buffer: string;
    status: string;
    liveStatus: string | null;
  }>;
};

type PlanResult = {
  title: string;
  subtitle: string;
  confidence: string;
  transferWindow: string;
  nextDeparture: string;
  liveStatus: string | null;
  departAt: string;
  transferCount: number;
  directions: Direction[];
  geometry: Array<{ line: keyof typeof LINE_COLORS; points: [number, number][] }>;
  markers: Array<{ kind: "board" | "transfer" | "arrive"; name: string; lat: number; lon: number }>;
  liveConnections: LiveConnection[];
};

type StationSuggestion = {
  stationId: string;
  stationName: string;
  reason: string;
};

const stationOptions = stationsForSelect();

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function HomePage() {
  const [originId, setOriginId] = useState("south-station");
  const [destinationId, setDestinationId] = useState("lechmere");
  const [departAt, setDepartAt] = useState(nowLocal());
  const [walkMinutes, setWalkMinutes] = useState(3);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [assistText, setAssistText] = useState("");
  const [assistStatus, setAssistStatus] = useState<"idle" | "loading" | "error">("idle");
  const [assistError, setAssistError] = useState<string | null>(null);
  const [assistSuggestions, setAssistSuggestions] = useState<StationSuggestion[]>([]);
  const [assistOpen, setAssistOpen] = useState(false);

  const planned = Boolean(result);

  async function onPlan() {
    setStatus("loading");
    setError(null);
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ originId, destinationId, departAt, walkMinutes })
    });
    const json = await res.json();
    if (!res.ok) {
      setStatus("error");
      setError(json.error ?? "Unable to plan this trip.");
      return;
    }
    setResult(json);
    setStatus("idle");
  }

  async function onSuggestStations() {
    if (!assistText.trim()) return;
    setAssistStatus("loading");
    setAssistError(null);
    setAssistSuggestions([]);
    const res = await fetch("/api/station-assist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: assistText })
    });
    const json = await res.json();
    if (!res.ok) {
      setAssistStatus("error");
      setAssistError(json.error ?? "Unable to suggest stations right now.");
      return;
    }
    setAssistSuggestions(json.suggestions ?? []);
    setAssistStatus("idle");
  }

  function onSwap() {
    setOriginId(destinationId);
    setDestinationId(originId);
    setResult(null);
  }

  const mapGeometry = useMemo(() => result?.geometry ?? [], [result]);
  const markers = useMemo(() => result?.markers ?? [], [result]);

  return (
    <main className="pageShell">
      <div className="appShell">
        <header className="appHeader">
          <div>
            <div className="eyebrow">MBTA Transfer Helper</div>
            <h1>Live transfer planning</h1>
            <p>Plan the route, preview the line map, and use Gemini when you are unsure which station fits your destination.</p>
          </div>
          <div className="linePills">
            {Object.entries(LINE_COLORS).map(([id, color]) => (
              <span key={id} className="linePill" style={{ borderColor: color, color }}>
                {LINE_LABELS[id as keyof typeof LINE_LABELS].replace(" Line", "")}
              </span>
            ))}
          </div>
        </header>

        <section className={`mainGrid ${planned ? "planned" : ""}`}>
          <div className="leftColumn">
            <section className="panelCard plannerCard">
              <div className="panelHeaderRow">
                <div>
                  <div className="sectionHeader">Trip setup</div>
                  <h2>Choose your route</h2>
                </div>
                <button className="swapButton" type="button" onClick={onSwap}>Swap</button>
              </div>

              <div className="formGrid">
                <div className="fieldBlock">
                  <label className="fieldLabel">Board at</label>
                  <select className="fieldInput" value={originId} onChange={(e) => setOriginId(e.target.value)}>
                    {stationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="fieldBlock">
                  <label className="fieldLabel">Head to</label>
                  <select className="fieldInput" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                    {stationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="fieldBlock">
                  <label className="fieldLabel">Depart at</label>
                  <input className="fieldInput" type="datetime-local" value={departAt} onChange={(e) => setDepartAt(e.target.value)} />
                </div>
                <div className="fieldBlock">
                  <label className="fieldLabel">Walk between platforms</label>
                  <div className="sliderCard">
                    <div className="sliderMeta"><strong>{walkMinutes} min</strong><span>Transfer window assumption</span></div>
                    <input type="range" min={1} max={8} step={1} value={walkMinutes} onChange={(e) => setWalkMinutes(Number(e.target.value))} />
                  </div>
                </div>
              </div>


              {error ? <div className="errorBox">{error}</div> : null}
              <div className="actionRow">
                <button className="secondaryButton" type="button" onClick={() => { setResult(null); setError(null); }}>Reset</button>
                <button className="primaryButton planButton" type="button" onClick={onPlan} disabled={status === "loading"}>
                  {status === "loading" ? "Planning…" : "Plan route"}
                </button>
              </div>
            </section>

            <section className="panelCard summaryCard">
              <div className="summaryTop">
                <div>
                  <div className="sectionHeader">Route summary</div>
                  <h2>{result?.title ?? "Ready to route"}</h2>
                  <p className="mutedText">{result?.subtitle ?? "Select an origin and destination, then press Plan route to load the trip."}</p>
                </div>
                {planned ? <span className={`confidencePill confidence-${result?.confidence?.toLowerCase()}`}>{result?.confidence}</span> : null}
              </div>
              <div className="summaryGrid">
                <div className="metricCard"><span>Departure</span><strong>{result?.departAt ?? "—"}</strong></div>
                <div className="metricCard"><span>Transfer window</span><strong>{result?.transferWindow ?? "—"}</strong></div>
                <div className="metricCard"><span>Transfers</span><strong>{result?.transferCount ?? "—"}</strong></div>
                <div className="metricCard"><span>Next train</span><strong>{result?.nextDeparture ?? "—"}</strong></div>
              </div>
              {result?.liveStatus ? <div className="statusStrip">Live MBTA status: {result.liveStatus}</div> : null}
            </section>



          </div>

          <div className="rightColumn">
            <section className="panelCard mapCard">
              <div className="sectionHeader">Interactive map</div>
              <h2>{planned ? "Trip path and transfer points" : "View the route map"}</h2>
              <p className="mutedText">The map expands when a route is planned and colors each ride segment using the MBTA line being taken.</p>
              <RouteMap geometry={mapGeometry} markers={markers} />
            </section>

            <section className="panelCard directionsCard">
              <div className="sectionHeader">Directions</div>
              <h2>{planned ? "Step-by-step guidance" : "Route guidance will appear here"}</h2>
              {planned ? (
                <div className="directionsList">
                  {result?.directions.map((step, idx) => (
                    <div key={step.id} className="directionItem" style={{ borderLeftColor: step.line ? LINE_COLORS[step.line] : "#94a3b8" }}>
                      <div className="directionIndex">{idx + 1}</div>
                      <div className="directionBody">
                        <strong>{step.title}</strong>
                        <span>{step.detail}</span>
                      </div>
                      <div className="directionBadge">{step.badge}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mutedText">After you plan a trip, this panel will show where to board, where to transfer, and where to arrive.</p>
              )}
            </section>

            <section className="panelCard connectionCard">
              <div className="sectionHeader">Live connection finder</div>
              <h2>{planned ? "Next available connections" : "Show next available trains"}</h2>
              {planned && result?.liveConnections?.length ? (
                <div className="connectionList">
                  {result.liveConnections.map((connection) => (
                    <div key={connection.id} className="connectionItem">
                      <div className="connectionTop">
                        <div className="connectionTitleBlock">
                          <strong>{connection.transferAt}</strong>
                          <span>{connection.connectionLabel}</span>
                        </div>
                        <div className="connectionTimingBlock">
                          <span>Arrive {connection.arriveAt}</span>
                          <span>Board after {connection.boardAfter}</span>
                        </div>
                      </div>
                      <div className="connectionOptions">
                        {connection.options.map((option, idx) => (
                          <div key={`${connection.id}-${idx}`} className="connectionOption">
                            <div>
                              <span className="connectionOptionLabel">{idx === 0 ? "Next connection" : "Fallback"}</span>
                              <strong>{option.departure}</strong>
                            </div>
                            <div>
                              <span className="connectionOptionLabel">Buffer</span>
                              <strong>{option.buffer}</strong>
                            </div>
                            <div>
                              <span className="connectionOptionLabel">Status</span>
                              <strong>{option.status}</strong>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mutedText">When you plan a route, this card shows the next boardable train at each transfer point using real-time MBTA predictions, plus the next fallback option.</p>
              )}
            </section>
          </div>
</section>
        <button
          type="button"
          className="geminiLauncher"
          aria-label="Open Gemini station assist"
          onClick={() => setAssistOpen((v) => !v)}
        >
          ✦
        </button>

        {assistOpen ? (
          <div className="assistModal">
            <div className="assistModalHeader">
              <div>
                <div className="sectionHeader">Gemini station assist</div>
                <h3>Find the right MBTA stop</h3>
              </div>
              <button type="button" className="assistClose" onClick={() => setAssistOpen(false)}>Close</button>
            </div>
            <p className="mutedText">Describe the place you want to reach and Gemini will suggest nearby MBTA stations.</p>
            <div className="assistRow">
              <textarea className="assistInput" placeholder="Near TD Garden, Boston Common, MIT, Logan Airport..." value={assistText} onChange={(e) => setAssistText(e.target.value)} />
              <button className="primaryButton" type="button" onClick={onSuggestStations} disabled={assistStatus === "loading"}>
                {assistStatus === "loading" ? "Finding stations…" : "Suggest stations"}
              </button>
            </div>
            {assistError ? <div className="errorBox">{assistError}</div> : null}
            {assistSuggestions.length ? (
              <div className="suggestionsGrid">
                {assistSuggestions.map((item) => (
                  <button key={item.stationId} className="suggestionCard" type="button" onClick={() => { setDestinationId(item.stationId); setAssistOpen(false); }}>
                    <strong>{item.stationName}</strong>
                    <span>{item.reason}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

      </div>
    </main>
  );
}
