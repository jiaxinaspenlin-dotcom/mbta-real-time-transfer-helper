"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

type LineRoute = { id: string; shortName: string; color: string; textColor: string };
type Station = { id: string; name: string; routeIds: string[]; mode?: "subway" | "bus" };

/**
 * A filter-as-you-type combobox. The network has ~125 stations, which is far too
 * many to hunt through in a native select on a phone.
 */
export default function StationPicker({
  label,
  value,
  stations,
  routeById,
  onChange
}: {
  label: string;
  value: string;
  stations: Station[];
  routeById: Record<string, LineRoute>;
  onChange: (stationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const [remote, setRemote] = useState<{ q: string; stops: Station[] } | null>(null);
  const [resolved, setResolved] = useState<Station | null>(null);

  const localMatch = stations.find((station) => station.id === value) ?? null;
  const selected = localMatch ?? (resolved?.id === value ? resolved : null);

  // A bus stop chosen by deep link is not in the preloaded subway list, so ask.
  useEffect(() => {
    if (!value || localMatch || resolved?.id === value) return;
    let active = true;
    fetch(`/api/stops?id=${encodeURIComponent(value)}`)
      .then((res) => res.json())
      .then((json) => {
        if (active && json.stops?.[0]) setResolved(json.stops[0]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [value, localMatch, resolved]);

  // Search runs on the server: ~6,900 stops across subway and bus is far too many
  // to ship to the browser.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    let active = true;
    const timer = setTimeout(() => {
      fetch(`/api/stops?q=${encodeURIComponent(q)}`)
        .then((res) => res.json())
        .then((json) => {
          if (active) setRemote({ q, stops: json.stops ?? [] });
        })
        .catch(() => active && setRemote({ q, stops: [] }));
    }, q ? 160 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Show subway matches instantly from the preloaded list, then let the server
    // results (which include bus) fill in behind them.
    const local = q
      ? stations.filter((station) => station.name.toLowerCase().includes(q))
      : stations;
    // Ignore results from a previous keystroke, or the list flashes stale stops.
    if (!remote || remote.q !== query.trim()) return local;
    const seen = new Set(local.map((station) => station.id));
    return [...local, ...remote.stops.filter((station) => !seen.has(station.id))];
  }, [stations, query, remote]);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  function commit(station: Station) {
    onChange(station.id);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => Math.min(matches.length - 1, Math.max(0, current + delta)));
      return;
    }
    if (event.key === "Enter" && open && matches[active]) {
      event.preventDefault();
      commit(matches[active]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setQuery("");
      setOpen(false);
    }
  }

  return (
    <div className="field stationField" ref={wrapRef}>
      <span id={`${listId}-label`}>{label}</span>
      <div className={`combo${open ? " open" : ""}`}>
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${listId}-list`}
          aria-labelledby={`${listId}-label`}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={selected ? selected.name : "Search stations…"}
          className={selected && !query ? "hasValue" : ""}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {selected && !open ? (
          // Cap the chips: interchanges like North Station serve enough lines to
          // overflow the field and spill outside the card.
          <div className="comboChips" aria-hidden>
            {selected.routeIds.filter((id) => routeById[id]).slice(0, 2).map((routeId) => (
              <span
                key={routeId}
                style={{ background: routeById[routeId]?.color, color: routeById[routeId]?.textColor }}
              >
                {routeById[routeId]?.shortName ?? routeId}
              </span>
            ))}
            {selected.mode === "bus" ? <span className="chipMore">Bus</span> : null}
            {selected.routeIds.filter((id) => routeById[id]).length > 2 ? (
              <span className="chipMore">+{selected.routeIds.filter((id) => routeById[id]).length - 2}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      {open ? (
        <ul className="comboList" id={`${listId}-list`} role="listbox">
          {matches.length ? (
            matches.slice(0, 60).map((station, index) => (
              <li key={station.id} role="option" aria-selected={station.id === value}>
                <button
                  type="button"
                  className={`${index === active ? "active " : ""}${station.id === value ? "chosen" : ""}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    commit(station);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <span className="comboName">{station.name}</span>
                  <span className="comboLines">
                    {station.mode === "bus" ? <em className="comboBus">Bus</em> : null}
                    {station.routeIds
                      .filter((routeId) => routeById[routeId])
                      .map((routeId) => (
                        <i key={routeId} style={{ background: routeById[routeId].color }} />
                      ))}
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="comboEmpty">
              {remote && remote.q === query.trim() ? `No stop matches “${query}”.` : "Searching…"}
            </li>
          )}
        </ul>
      ) : null}
    </div>
  );
}
