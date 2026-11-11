import { lazy, Suspense, useState } from "react";
import { MapPin, Search } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { Button } from "../ui/kit";

const PinMap = lazy(() => import("./PinMap"));

interface Hit { name: string; address: string; lat: number; lng: number; city?: string; region?: string; countryCode?: string; cityId?: string }

/** "Nairobi Gate C" → "NAIROBI-GATE-C": a starting code the person can change. */
const codeFrom = (name: string) => name.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toUpperCase().replace(/[\s_]+/g, "-").slice(0, 32);

/**
 * Where a place is, without typing latitude and longitude (#102): search by name or address, or put the pin on
 * the map. Picking a result fills the pin, and the name, code, street address and city when they're still empty.
 */
export function PlaceFinder({ value, onChange }: { value: Rec; onChange: (v: Rec) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const at = value.location as { lat: number; lng: number } | undefined;

  const find = async () => {
    if (q.trim().length < 2) return;
    setBusy(true);
    setNote("");
    try {
      const answer = await api<{ results: Hit[]; searchedIn: string | null }>("/places/find", { query: { q: q.trim() } });
      setHits(answer.results);
      if (!answer.results.length) setNote(answer.searchedIn ? `Nothing found in ${answer.searchedIn}. Try fewer words, the town's name, or put the pin on the map.` : "Nothing found. Try fewer words, or put the pin on the map.");
    } catch (e) {
      setHits(null);
      setNote(e instanceof ApiError ? e.message : "The search didn't answer. Put the pin on the map instead.");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (h: Hit) => {
    const address = (value.address ?? {}) as Rec;
    const name = String(value.name ?? "") || h.name;
    let next: Rec = {
      ...value,
      location: { lat: h.lat, lng: h.lng },
      name,
      code: value.code || codeFrom(name),
      address: { ...address, line1: address.line1 || h.address.slice(0, 200) },
    };
    onChange(next);
    setHits(null);
    setNote(`Pinned at ${h.name}. Drag the pin to the gate if it's not quite there.`);
    if (value.cityId || !h.city || !h.countryCode) return;
    // The city it's in: one of the company's, or added for it.
    try {
      const city = await api<{ cityId: string | null; created: boolean }>("/places/city-for", { method: "POST", body: { city: h.city, region: h.region, countryCode: h.countryCode, lat: h.lat, lng: h.lng } });
      if (city.cityId) {
        next = { ...next, cityId: city.cityId, address: { ...(next.address as Rec), cityId: (next.address as Rec)?.cityId || city.cityId } };
        onChange(next);
        if (city.created) setNote(`Pinned at ${h.name}. ${h.city} was added to the cities.`);
      }
    } catch {
      /* the city stays to choose by hand */
    }
  };

  return (
    <section className="place-finder" aria-label="Where it is">
      <div className="place-finder-search">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void find(); } }}
          placeholder="Find it: a name, an address or a town" aria-label="Find a place by name or address" />
        <Button size="sm" busy={busy} onClick={() => void find()}><Search size={14} /> Find</Button>
      </div>
      {hits && hits.length > 0 && (
        <ul className="place-hits">
          {hits.map((h, i) => (
            <li key={`${h.lat},${h.lng},${i}`}>
              <button type="button" onClick={() => void pick(h)}>
                <MapPin size={14} aria-hidden />
                <span><strong>{h.name}</strong><span className="muted">{h.address}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="muted small" role="status">{note}</p>}
      <Suspense fallback={<div className="pin-map" />}>
        <PinMap at={at} onPick={(p) => { onChange({ ...value, location: p }); setNote(""); }} />
      </Suspense>
      <p className="muted small">{at ? `Pin: ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}. Click the map or drag the pin to move it.` : "No pin yet: find the place above, or click the map where it is."}</p>
    </section>
  );
}
