"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

type LineRoute = { id: string; shortName: string; color: string; textColor: string };
type Station = { id: string; name: string; routeIds: string[] };

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

  const selected = stations.find((station) => station.id === value) ?? null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stations;
    // Prefer names that start with the query, so "north" surfaces North Station
    // before Northeastern's neighbours.
    const starts: Station[] = [];
    const contains: Station[] = [];
    for (const station of stations) {
      const name = station.name.toLowerCase();
      if (name.startsWith(q)) starts.push(station);
      else if (name.includes(q)) contains.push(station);
    }
    return [...starts, ...contains];
  }, [stations, query]);

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
            {selected.routeIds.slice(0, 2).map((routeId) => (
              <span
                key={routeId}
                style={{ background: routeById[routeId]?.color, color: routeById[routeId]?.textColor }}
              >
                {routeById[routeId]?.shortName ?? routeId}
              </span>
            ))}
            {selected.routeIds.length > 2 ? (
              <span className="chipMore">+{selected.routeIds.length - 2}</span>
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
                    {station.routeIds.map((routeId) => (
                      <i key={routeId} style={{ background: routeById[routeId]?.color }} />
                    ))}
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="comboEmpty">No station matches “{query}”.</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}
