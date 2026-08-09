# MBTA Transfer Helper

A real-time transfer planner for the MBTA rapid transit network: plan a trip, see
whether you will actually make each connection, and simulate what happens if you
leave late or your train runs behind.

## Data policy

Every value a rider sees comes from a live source. Station names, coordinates, line
colours, branch ordering, departure times and arrival times are all read from the
[MBTA v3 API](https://api-v3.mbta.com/docs/swagger/index.html). There is no bundled
station list, no sample trip, and no canned fallback text.

When the API cannot answer, the app says so — an unreachable network shows an error
screen, a leg with no reported service is named in a "Gaps in the MBTA feed" panel,
and missing times render as `—`. Nothing is filled in with an estimate.

There is one deliberate exception, and the UI states it inline: **your
platform-to-platform walk time is a control you set, not a value the app derives.**
The MBTA API returns identical coordinates for every platform at a station (all
eight Park Street platforms share one point) and publishes no transfer times, so any
per-station walking estimate would be invented.

## Features

- **Interactive map** — every rapid transit line and station drawn from the live
  network. Tap a station for "Start here" / "End here"; the planned trip is drawn
  thick over the dimmed rest of the system.
- **Transfer guidance** — set your own walk time (1–15 min); every connection is
  scored against it.
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
  up to 30 min late. The trip re-plans against live data automatically.
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

1. The network is loaded once from `/routes` (types 0 and 1: light and heavy rail,
   which is Red, Mattapan, Orange, Green B/C/D/E and Blue) plus one
   `/route_patterns?canonical=true` call that returns the ordered stops of every
   branch. That yields ~125 stations and a branch-aware graph.
2. A shortest-path search over that graph minimises transfers first, then number of
   stops, and groups the result into rides and transfers.
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
| `GET /api/network` | Routes, stations and line shapes for the map and pickers |
| `POST /api/plan` | Plans a trip; body takes `originId`, `destinationId`, `departAt`, `walkMinutes`, `departShiftMinutes`, `delayMinutes` |
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

## Project structure

```
app/
  page.tsx                     UI (client component)
  layout.tsx                   Metadata and viewport
  globals.css                  Design tokens, layout, responsive rules
  api/network/route.ts         Live network for the client
  api/plan/route.ts            Trip planning and confidence scoring
  api/station-assist/route.ts  OpenAI station matching
components/
  RouteMap.tsx                 Leaflet map, selection, trip overlay
lib/
  mbta-api.ts                  Fetch wrapper, error handling, Boston-time helpers
  mbta.ts                      Departures, trip arrivals, scoring, formatting
  network.ts                   Network loader, graph, trip planner
```

## Known limitations

- **Rapid transit only.** Commuter rail, bus, ferry and the Silver Line are not
  included, since the planner loads route types 0 and 1.
- **Walk time is your input**, for the reason described above.
- **Early morning and late night** have sparse predictions. The app falls back to
  the timetable where it can and reports the gap where it cannot, rather than
  showing times that do not exist.
