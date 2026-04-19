import { NextRequest, NextResponse } from "next/server";
import { stationCandidatesFallback } from "@/lib/mbta";
import { STATION_BY_ID } from "@/lib/network";

export async function POST(req: NextRequest) {
  const { query } = await req.json();
  if (!query || !String(query).trim()) {
    return NextResponse.json({ error: "Enter a destination or landmark first." }, { status: 400 });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json({ suggestions: stationCandidatesFallback(query) });
  }

  const prompt = `You are helping with Boston MBTA station selection. Return ONLY JSON in this exact shape: {"suggestions":[{"stationId":"park-street","reason":"..."}]} with 1 to 3 suggestions. Use only these station IDs: alewife, harvard, park-street, downtown-crossing, south-station, north-station, state, government-center, bowdoin, airport, wonderland, forest-hills, back-bay, ruggles, lechmere, science-park, copley, northeastern. Query: ${query}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    });

    if (!res.ok) {
      return NextResponse.json({ suggestions: stationCandidatesFallback(query) });
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text ?? "{}");
    const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    const cleaned = suggestions
      .filter((item: any) => item?.stationId && STATION_BY_ID[item.stationId])
      .slice(0, 3)
      .map((item: any) => ({
        stationId: item.stationId,
        stationName: STATION_BY_ID[item.stationId].name,
        reason: String(item.reason ?? "Good match for the requested destination.")
      }));

    return NextResponse.json({ suggestions: cleaned.length ? cleaned : stationCandidatesFallback(query) });
  } catch {
    return NextResponse.json({ suggestions: stationCandidatesFallback(query) });
  }
}
