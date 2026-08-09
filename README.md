# MBTA Transfer Helper

A real-time multimodal transfer planner for the MBTA — subway, bus and the short
walks between them. Plan a trip, see whether you will actually make each
connection, and simulate what happens if you leave late or your train runs behind.

## Data policy

Every value a rider sees comes from a live source. Station names, coordinates, line
colours, branch ordering, departure times and arrival times are all read from the
[MBTA v3 API](https://api-v3.mbta.com/docs/swagger/index.html). There is no bundled
station list, no sample trip, and no canned fallback text.

When the API cannot answer, the app says so — an unreachable network shows an error
screen, a leg with no reported service is named in a "Gaps in the MBTA feed" panel,
and missing times render as `—`. Nothing is filled in with an estimate.

Walking time is handled two different ways, because the data supports one and not
the other:

- **Between separate stops** (a bus stop to a station entrance) the coordinates are
  genuinely distinct, so the distance is real and the app shows it: *walk 114 m to
  Park Street (1 min)*.
- **Between platforms inside one station** the API returns identical coordinates for
  every platform — all eight at Park Street share a single point — and publishes no
  transfer times. So that number is a control you set, and the UI says so.

## The flow

The app is built around the shape of an actual trip rather than a form and a report:

1. **Arrive** — one question, "Where to?". `◎ Nearest to me` fills the origin from
   your location; the empty state says what you are about to get.
2. **Choose** — filter-as-you-type pickers, tap-to-select on the map, or describe a
   landmark in plain language.
3. **Plan** — there is no plan button. The moment both stations are known, the trip
   plans itself; the button becomes a refresh.
4. **Read** — a **Right now** card leads with the single next action, the timeline
   draws rides and waits to scale, and each transfer explains its own badge in a
   sentence.
5. **Ride** — the interface advances on its own: *board → on board → transfer now →
   on board → arrived*, driven entirely by the leg timestamps.
6. **Arrive** — a completion state, with the return trip one tap away.

A pinned trip strip keeps the route and its confidence visible throughout, and the
walk-time and what-if controls only appear once there is an answer to refine.

## Features

- **Interactive map** — every rapid transit line and station drawn from the live
  network. Tap a station for "Start here" / "End here"; the planned trip is drawn
  thick over the dimmed rest of the system. Bus legs and walking links appear as
  part of a planned trip (walks dashed), since drawing 149 bus routes at rest would
  swamp the map.
- **Service alerts** — active suspensions, closures and delays touching the trip.
  These are also returned when a leg has no service, so a dead end explains itself.
- **Rerouting** — the planner routes around whatever is out of service. During a
  Green Line suspension, Park Street → Government Center (normally one stop) is
  replanned via other lines, with a banner saying why.
- **Subway, bus and walking** — 8 subway routes and 149 bus routes in one graph,
  joined by walking links between stops within 400 m. A trip can be Bus SL5, a
  114 m walk, then the Red Line.
- **Transfer guidance** — set your own walk time (1–15 min); every connection is
  scored against it. A tight connection offers to retry at a faster pace.
- **Shareable links** — the trip lives in the URL (`?from=…&to=…&walk=…`), so it can
  be bookmarked or sent to someone. No storage is used.
- **Live connection finder** — the next departures at each transfer with headsigns.
  The published timetable is used only when the prediction feed is empty, and the
  result is labelled *Live predictions*, *Scheduled times*, or *Live + scheduled*.
- **Confidence indicator** — Likely / Risky / Unlikely per connection:

  | Badge | Slack after you reach the platform |
  | --- | --- |
  | Likely | 3 min or more |
  | Risky | 0 to 3 min |
  | Unlikely | train leaves before you get there |

  The trip headline reports the tightest connection you are actually put on, so the
  headline and the itinerary never disagree.
- **What-if scenarios** — simulate leaving up to 60 min later or your train running
  up to 30 min late. The trip re-plans against live data automatically and shows the
  result as a before/after delta rather than silently replacing the numbers.
- **Station assist** (optional) — describe a destination in plain language and
  OpenAI matches it to real stations. Suggestions are validated against the live
  network, so it cannot invent a stop.

### Branch awareness

Filtering departures by route and direction is not enough on this system: the Red
Line splits at JFK/UMass and the Green Line splits four ways. A Downtown Crossing
train marked "Red Line, southbound" may be an Ashmont train that never reaches
Braintree. Each candidate train is therefore checked against its own stop list;
trains that cannot complete your leg are shown but marked **Wrong branch**.

## Setup

Requires Node 18.17 or newer (developed on Node 24).

1. Copy the env template:

   ```bash
   cp .env.example .env.local
   ```

2. Fill in `.env.local` (it is gitignored; never commit real keys):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `MBTA_API_KEY` | Recommended | Works without one, but the anonymous rate limit is low enough to hit while planning. [Free registration](https://api-v3.mbta.com/register). |
   | `OPENAI_API_KEY` | Optional | Enables the ✦ station assist panel only. Everything else works without it. |
   | `OPENAI_MODEL` | Optional | Defaults to `gpt-4o-mini`. Leaving it blank is fine. |

3. Install and run:

   ```bash
   npm install
   npm run dev
   ```

   Open <http://localhost:3000>.

Next.js reads environment variables at startup, so **restart the dev server after
editing `.env.local`**.

For a production build: `npm run build && npm start`. On a host, set the same
variables in its environment settings — `.env.local` is intentionally not committed.

## How it works

### Trip planning

1. The network is loaded once and cached: 8 subway routes via
   `/route_patterns?canonical=true`, and 149 bus routes in batches of 25. Bus routes
   carry no canonical flag, so their "typical" patterns are used instead. That is
   ~6,900 stops and ~11,000 directed edges, built in about 1.3 seconds cold and
   served from memory afterwards.
   Stops within 400 m of each other are then linked by walking edges — bucketed into
   a coarse grid, since comparing all stops pairwise would be 47 million checks.
   These walk links are what make bus/subway transfers possible.
2. A binary-heap Dijkstra over that graph, weighted in rough minutes with a boarding
   penalty per mode (buses cost more to board, which is what stops it suggesting six
   buses to save one transfer). **These costs only rank candidate routes — every
   time shown to a rider still comes from a real prediction.** The result is grouped
   into rides and walks. Anything a disabling alert
   covers is removed from the graph first, keyed by `routeId|stationId` so a
   suspension takes out one line's edges at a station rather than the station
   itself. If the feed then dries up for a reason no alert covers, the planner
   retries once without the route that failed.
3. For each leg the app fetches real departures at the boarding station, then
   resolves every candidate train's real arrival at the leg's destination in a
   single batched request (plus one timetable lookup if the prediction feed is
   missing some of those trips). It boards the first train that both leaves after
   you can reach the platform and actually serves the destination.

### Caching

| Data | Lifetime | Why |
| --- | --- | --- |
| Network graph | 12 h in-process, 24 h fetch cache | Routes and station ordering rarely change |
| Predictions | 15 s | Real-time |
| Schedules | 5 min | Timetables are static for the day |

### Routes

| Endpoint | Purpose |
| --- | --- |
| `GET /api/network` | Subway routes, stations and line shapes for the map. Deliberately excludes bus: ~6,800 extra stops would swamp both the payload and Leaflet |
| `GET /api/stops?q=` | Stop search across subway and bus, filtered server-side. `?id=` resolves ids for deep links |
| `POST /api/plan` | Plans a trip; body takes `originId`, `destinationId`, `departAt`, `walkMinutes`, `departShiftMinutes`, `delayMinutes`. Returns formatted strings **and** raw ISO timestamps, which is what lets the client count down and track the journey without refetching |
| `POST /api/station-assist` | Plain-language destination → station suggestions |

Numeric inputs are clamped server-side (walk 1–15 min, later start 0–60 min, delay
0–30 min), so a hand-crafted request cannot produce nonsense output.

### Layout

| Width | Layout |
| --- | --- |
| < 900 px | Single column with a Plan / Map / Trip tab bar, 44 px tap targets |
| 900–1359 px | Two columns, trip results underneath |
| ≥ 1360 px | Three columns |

Light and dark themes follow the system setting.

Lines are shown as MBTA-style bullets: a coloured circle with the branch letter —
**RL**, **OL**, **BL**, **M**, and **B/C/D/E** for the Green Line branches. Colour
carries the line and the letter carries the branch, so the blue **BL** and the green
**B** do not collide. Colours and names come from the API; only the letter is a
display convention, and any route without one falls back to a derived initial.

## Project structure

```
app/
  page.tsx                     UI (client component)
  layout.tsx                   Metadata and viewport
  globals.css                  Design tokens, layout, responsive rules
  icon.svg                     Favicon (interchange mark)
  api/network/route.ts         Subway network for the map
  api/stops/route.ts           Stop search across subway and bus
  api/plan/route.ts            Trip planning, rerouting, confidence scoring
  api/station-assist/route.ts  OpenAI station matching
components/
  RouteMap.tsx                 Leaflet map, selection, trip overlay
  StationPicker.tsx            Filter-as-you-type station combobox
  NowCard.tsx                  The advancing "right now" instruction
  Timeline.tsx                 Rides and waits drawn to scale
lib/
  mbta-api.ts                  Fetch wrapper, error handling, Boston-time helpers
  mbta.ts                      Departures, trip arrivals, alerts, scoring, formatting
  network.ts                   Network loader, graph, trip planner
  time.ts                      Countdowns and the journey state machine (client-safe)
```

## Known limitations

- **No commuter rail or ferry.** The planner loads route types 0, 1 and 3.
- **In-station walk time is your input**, for the reason described above. Walks
  between separate stops are measured from real coordinates.
- **Early morning and late night** have sparse predictions. The app falls back to
  the timetable where it can and reports the gap where it cannot, rather than
  showing times that do not exist.
- **Replacement shuttles are not routable.** The MBTA publishes them in alert text
  rather than as routes in the API, so a suspension is routed around using regular
  bus and subway service, or reported as impassable.
- **Walking links are straight-line**, not street-network distances, so a walk
  across a river or rail cut reads shorter than it walks.
- **Journey tracking is time-based, not location-based.** It advances on the clock,
  so it assumes you boarded the train it put you on.
