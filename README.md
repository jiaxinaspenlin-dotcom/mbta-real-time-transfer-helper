# MBTA Transfer Helper

A real-time transfer planner for the MBTA rapid transit network.

Everything a rider sees comes from a live source. The station list, line colours,
route ordering, departure times and arrival times are all read from the
[MBTA v3 API](https://api-v3.mbta.com/docs/swagger/index.html) at request time.
There is no bundled station list, no sample trip, and no canned fallback text — if
the API cannot answer, the app says so instead of showing a placeholder.

## What it does

- **Interactive map** — every subway line and station drawn from the live network.
  Tap a station to set it as your start or destination; the planned trip is
  highlighted over the dimmed network.
- **Transfer guidance** — you set your own platform-to-platform walking time, and
  every connection is scored against it.
- **Live connection finder** — the next departures at each transfer, taken from
  real-time predictions, with the published timetable used only when the
  prediction feed is empty (and labelled as such).
- **Confidence indicator** — Likely / Risky / Unlikely per connection, based on the
  slack between your arrival, your walk, and the next train's departure.
- **What-if scenarios** — simulate leaving later or your train running late, and
  watch the confidence change.

### On walking times

The MBTA API returns the same coordinates for every platform at a station and does
not publish transfer walking times, so a per-station estimate would be invented.
The walk time is therefore a control you set, and the UI says so.

## Run

1. Copy `.env.example` to `.env.local`
2. Fill in your keys:
   - `MBTA_API_KEY` — optional, but the API is rate limited without one
     ([request one free](https://api-v3.mbta.com/register))
   - `OPENAI_API_KEY` — optional, enables the station assist panel
   - `OPENAI_MODEL` — optional, defaults to `gpt-4o-mini`
3. Install and start:

```bash
npm install
npm run dev
```

Open http://localhost:3000
