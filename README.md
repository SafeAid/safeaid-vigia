# SafeAid Vigía

The **fast channel** of [SafeAid](https://safeaid.io): a tiny pipeline that runs
every ~10 minutes on GitHub Actions and publishes `vigia.json` with, worldwide:

- **Earthquakes** — USGS + EMSC (last 24 h), fused with **dual-network
  confirmation** (|ΔM| ≤ 0.5, Δt ≤ 120 s, ≤ 100 km) and a felt-radius estimate.
- **Disasters** — GDACS orange/red events (cyclones, floods, eruptions…) with
  coordinates and a relevance radius.
- **Official weather alerts** — the WMO worldwide feed
  (severeweather.wmo.int): the national meteorological services of ~130
  countries in one integration. Argentina's SMN is also queried directly as a
  best-effort reinforcement.
- **Coverage matrix** per country, derived from what was actually observed —
  never from promises.

Everything comes from public sources; there are no secrets here. A source that
is down is declared in `sources_ok` and never blocks the run.

Consumed by the SafeAid app at:

```
https://raw.githubusercontent.com/SafeAid/safeaid-vigia/main/vigia.json
```

Run locally: `node run.mjs` (Node ≥ 22, no dependencies).
