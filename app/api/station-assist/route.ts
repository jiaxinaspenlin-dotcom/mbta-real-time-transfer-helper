import { NextRequest, NextResponse } from "next/server";
import { MbtaApiError } from "@/lib/mbta-api";
import { loadNetwork } from "@/lib/network";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export async function POST(req: NextRequest) {
  const { query } = await req.json();
  if (!query || !String(query).trim()) {
    return NextResponse.json({ error: "Enter a destination or landmark first." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Station assist is off. Add OPENAI_API_KEY to .env.local to turn it on." },
      { status: 503 }
    );
  }

  let network;
  try {
    network = await loadNetwork();
  } catch (error) {
    const message = error instanceof MbtaApiError ? error.message : "Could not load the MBTA network.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // The model may only choose from stations that actually exist in the live network.
  const catalog = network.stations
    .map((station) => `${station.id} = ${station.name} (${station.routeIds.join(", ")})`)
    .join("\n");

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        // `??` is wrong here: an unset-but-present `OPENAI_MODEL=` in .env is an
        // empty string, which OpenAI rejects. Fall back on anything blank.
        model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You match Boston destinations to MBTA rapid transit stations. Reply with JSON shaped " +
              '{"suggestions":[{"stationId":"...","reason":"..."}]} containing 1 to 3 entries, best first. ' +
              "Use only station ids from the provided list. Keep each reason under 20 words. " +
              'If nothing in the list is a reasonable match, reply {"suggestions":[]}.\n\nStations:\n' +
              catalog
          },
          { role: "user", content: String(query) }
        ]
      })
    });

    if (!res.ok) {
      // Pass OpenAI's own reason through; a bare status code is not diagnosable.
      const detail = await res
        .json()
        .then((body) => body?.error?.message)
        .catch(() => null);
      return NextResponse.json(
        { error: `Station assist failed: OpenAI returned ${res.status}${detail ? ` — ${detail}` : "."}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];

    const cleaned = suggestions
      .filter((item: any) => item?.stationId && network.stationById[item.stationId])
      .slice(0, 3)
      .map((item: any) => ({
        stationId: item.stationId,
        stationName: network.stationById[item.stationId].name,
        routeIds: network.stationById[item.stationId].routeIds,
        reason: String(item.reason ?? "").trim()
      }));

    return NextResponse.json({ suggestions: cleaned });
  } catch (error) {
    return NextResponse.json({ error: "Station assist could not reach OpenAI." }, { status: 502 });
  }
}
