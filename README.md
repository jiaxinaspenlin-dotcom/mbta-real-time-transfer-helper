# MBTA Transfer Helper

MBTA Transfer Helper is a web application designed to help riders evaluate whether they can successfully make an MBTA subway transfer in real time. The app combines route visualization, transfer guidance, live departure timing, and natural-language station assistance to make trips easier to understand and act on.

## Overview

Public transit riders often know where they want to go, but not always which station or transfer point gives them the best chance of making the next train. MBTA Transfer Helper addresses that problem by showing a rider’s path on an interactive map, estimating transfer feasibility based on walking assumptions, and surfacing the next available connection using real-time MBTA data.

This project was built as an app-style interface rather than a traditional webpage, with a focus on usability, route clarity, and transfer decision support.

## Features

- **Interactive trip map**  
  Visualizes the selected route on a live map and highlights transfer points across the MBTA network.

- **Transfer guidance**  
  Provides step-by-step directions showing where to board, where to transfer, and where to exit.

- **Live connection finder**  
  Uses real-time MBTA departure data to show the next available connection and a fallback option.

- **Confidence indicator**  
  Evaluates transfer feasibility based on timing and walking assumptions, helping users judge whether a connection is likely, risky, or unlikely.

- **Gemini station assist**  
  Lets users describe a destination in natural language and receive suggested MBTA stations that best match the location.

- **Custom walking assumptions**  
  Allows the rider to adjust platform-to-platform walking time, which updates transfer feasibility.

## Why I Built It

I wanted to build a transit-focused application that goes beyond standard trip planning by helping riders make better transfer decisions in real time. Many transit tools show schedules and maps, but fewer help answer the practical question: **Can I actually make this connection?**

This project also gave me the opportunity to combine API integration, route and timing logic, map-based UI design, real-time decision support, and LLM-assisted interaction in a single end-to-end application.

## Tech Stack

- Next.js
- TypeScript
- Leaflet
- MBTA API
- Google Gemini API

## How It Works

1. The user selects an origin station and destination station.
2. The app builds a route using the project’s internal routing logic.
3. The route is rendered on the map with MBTA line-aware colors and transfer markers.
4. Real-time MBTA departure data is used to evaluate upcoming connections.
5. The app calculates the transfer window using the user’s walking-time assumption.
6. Gemini can assist when the user knows the destination they want, but not the best station to choose.

## Project Structure

```bash
app/
  api/
    gemini/
    mbta-live/
  components/
  lib/
  public/
```

## Prerequisites

Make sure you have installed:

- Node.js (version 18 or later recommended)
- npm

## Installation

Clone the repository:

```bash
git clone https://github.com/jiaxinaspenlin-dotcom/mbta-real-time-transfer-helper.git
cd mbta-real-time-transfer-helper
```

Install dependencies:

```bash
npm install
```

## Environment Variables

Create a `.env.local` file in the root of the project and add:

```env
MBTA_API_KEY=your_mbta_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
```
## Run the Development Server

Start the app locally:

```bash
npm run dev
```
Then open:

```text
http://localhost:3000
```

## Environment Variables

- `MBTA_API_KEY` — used for live MBTA departure data
- `GEMINI_API_KEY` — used for Gemini-powered station suggestions

## Future Improvements

- Expand live connection coverage across more MBTA branches and edge cases
- Improve transfer simulation for delays and missed-train scenarios
- Add saved trips and recent searches
- Improve mobile responsiveness and deployment polish

## Notes
This project is a prototype built for transfer planning and rider decision support. It is not an official MBTA application.
