// src/lib.mjs — núcleo PURO del vigía de eventos de SafeAid.
// Copia standalone del motor principal (repo privado); mantener en sincronía.
// Acá no hay red: parseo, matching y geometría, todo testeable.
import { iso2to3 } from './iso.mjs';

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Feed mundial de la OMM (severeweather.wmo.int/v2/json/wmo_all.json): las
 * alertas OFICIALES de los servicios meteorológicos nacionales de ~130 países,
 * agregadas y actualizadas al minuto. «El SMN de cada país» en una integración.
 * El país viene codificado como prefijo alpha-2 del campo url ("cn-cma-…").
 */
export function parseWmoWarnings(json, { now = Date.now() } = {}) {
  const out = [];
  for (const w of json?.items ?? []) {
    // El feed usa capURL en la mayoría de los ítems y url en algunos; el
    // prefijo alpha-2 del path es el emisor nacional ("fr-meteofrance-…").
    const iso2 = /^([a-z]{2})-/i.exec(w.capURL ?? w.url ?? '')?.[1];
    const iso3 = iso2to3(iso2);
    if (!iso3 || !w.event) continue;
    // HALLAZGO 29-sep: wmo_all.json es un archivo RODANTE — trae alertas ya
    // vencidas (las 73 de AR estaban todas caducas). Sin filtro de vigencia,
    // este parser miente «vigentes». Es el RESPALDO del WFS (parseWmoWfs).
    if (w.expires && !isExpiryValid(w.expires, now)) continue;
    out.push({
      id: `wmo:${w.id}`,
      source: 'wmo',
      iso3,
      event: String(w.event),
      headline: w.headline ? String(w.headline).slice(0, 160) : null,
      area: w.areaDesc ? String(w.areaDesc).slice(0, 120) : null,
      sent: w.sent ?? null,
      expires: w.expires ?? null,
    });
  }
  return out;
}

/** «2026-09-10 17:59:59» o ISO → ¿sigue vigente a `now`? (sin fecha = vigente) */
function isExpiryValid(expires, now) {
  const t = Date.parse(String(expires).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(expires)) ? '' : 'Z'));
  return Number.isNaN(t) ? true : t > now;
}

// ------------------------------------------------------------- zonas por alerta
// Pedido de Javier (29-sep): «ubicación y alertas por ciudad, no por país».
// El WFS de SWIC (local_postgis:postgis_geojsons, row_type='POLYGON') publica
// el polígono real de cada alerta, casable por capurl. Acá se simplifica a
// nivel ciudad (~2 km) para que el JSON siga siendo liviano y el TELÉFONO
// decida si el punto del usuario cae adentro — la ubicación no viaja nunca.

/** Redondea a la grilla, borra vértices repetidos y adelgaza a maxPoints. */
export function simplifyRing(ring, { grid = 0.02, maxPoints = 60 } = {}) {
  const out = [];
  let prev = null;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lng = Math.round(Math.round(p[0] / grid) * grid * 100) / 100;
    const lat = Math.round(Math.round(p[1] / grid) * grid * 100) / 100;
    if (!prev || lng !== prev[0] || lat !== prev[1]) { prev = [lng, lat]; out.push(prev); }
  }
  if (out.length <= maxPoints) return out;
  const paso = Math.ceil(out.length / maxPoints);
  const fino = out.filter((_, i) => i % paso === 0);
  const ultimo = out[out.length - 1];
  if (fino[fino.length - 1] !== ultimo) fino.push(ultimo);
  return fino;
}

/** [oeste, sur, este, norte] del anillo ORIGINAL (prefiltro sin pérdida). */
export function bboxOfRing(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue;
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  const r = (v) => Math.round(v * 100) / 100;
  return [r(w), r(s), r(e), r(n)];
}

/**
 * FUENTE PRIMARIA de alertas oficiales: el WFS de SWIC
 * (local_postgis:postgis_geojsons, row_type='POLYGON') — solo lo VIGENTE y con
 * el polígono real de cada alerta. Una alerta (capurl) puede venir en varias
 * features (una por área): acá se agrupan en un solo item con `zones`.
 */
export function parseWmoWfs(wfsJson, { now = Date.now(), maxZonesPerAlert = 4, maxPoints = 60 } = {}) {
  const byCap = new Map();
  for (const f of wfsJson?.features ?? []) {
    const p = f?.properties ?? {};
    const cap = p.capurl;
    if (!cap) continue;
    const iso3 = iso2to3(/^([a-z]{2})-/i.exec(cap)?.[1]);
    if (!iso3 || !p.event) continue;
    if (p.expires && !isExpiryValid(p.expires, now)) continue;
    let alerta = byCap.get(cap);
    if (!alerta) {
      alerta = {
        id: `wmo:${cap}`,
        source: 'wmo',
        iso3,
        event: String(p.event),
        headline: p.headline ? String(p.headline).slice(0, 160) : String(p.event),
        area: p.areadesc ? String(p.areadesc).slice(0, 120) : null,
        sent: p.sent ?? null,
        onset: p.onset ?? null,
        expires: p.expires ?? null,
        zones: [],
      };
      byCap.set(cap, alerta);
    }
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates]
      : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const coords of polys) {
      const outer = coords?.[0];
      if (!Array.isArray(outer) || outer.length < 4) continue;
      if (alerta.zones.length >= maxZonesPerAlert) break;
      const ring = simplifyRing(outer, { maxPoints });
      if (ring.length < 3) continue;
      alerta.zones.push({ bbox: bboxOfRing(outer), ring });
    }
  }
  // Sin zona útil la alerta vale igual (queda a nivel país, declarada).
  return [...byCap.values()].map((a) => (a.zones.length ? a : { ...a, zones: undefined }));
}

/** Agrupa las alertas OMM por país: { ISO3: { count, events:[tipos], items:[…máx N] } } */
export function wmoByCountry(warnings, { maxItemsPerCountry = 12 } = {}) {
  const by = {};
  for (const w of warnings) {
    if (!by[w.iso3]) by[w.iso3] = { count: 0, events: {}, items: [] };
    const c = by[w.iso3];
    c.count++;
    c.events[w.event] = (c.events[w.event] ?? 0) + 1;
    if (c.items.length < maxItemsPerCountry) c.items.push(w);
  }
  return by;
}

/** USGS GeoJSON (all_day/all_hour) → eventos normalizados. */
export function parseUsgsGeojson(geojson) {
  const out = [];
  for (const f of geojson?.features ?? []) {
    const p = f.properties ?? {};
    const [lng, lat, depth] = f.geometry?.coordinates ?? [];
    if (p.time == null || lat == null || lng == null || p.mag == null) continue;
    out.push({
      id: `usgs:${f.id}`,
      source: 'usgs',
      t: new Date(p.time).toISOString(),
      mag: p.mag,
      lat, lng,
      depth_km: depth ?? null,
      place: p.place ?? null,
      tsunami: p.tsunami === 1,
      url: p.url ?? null,
    });
  }
  return out;
}

/** EMSC FDSN event query (format=json) → eventos normalizados. */
export function parseEmscFdsn(json) {
  const out = [];
  for (const f of json?.features ?? []) {
    const p = f.properties ?? {};
    if (p.time == null || p.lat == null || p.lon == null || p.mag == null) continue;
    out.push({
      id: `emsc:${p.source_id ?? f.id}`,
      source: 'emsc',
      t: new Date(p.time).toISOString(),
      mag: p.mag,
      lat: p.lat,
      lng: p.lon,
      depth_km: p.depth ?? null,
      place: p.flynn_region ?? null,
      tsunami: false,
      url: p.source_id ? `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid ?? p.source_id}` : null,
    });
  }
  return out;
}

/** Mismas tolerancias que sismo-dual (§5.3/§16): |ΔM|≤0.5 · |Δt|≤120 s · dist≤100 km. */
export const MATCH_TOL = { deltaMagMax: 0.5, deltaSecMax: 120, deltaKmMax: 100 };

export function sameQuake(a, b, tol = MATCH_TOL) {
  if (Math.abs(a.mag - b.mag) > tol.deltaMagMax) return false;
  if (Math.abs(Date.parse(a.t) - Date.parse(b.t)) / 1000 > tol.deltaSecMax) return false;
  return haversineKm(a.lat, a.lng, b.lat, b.lng) <= tol.deltaKmMax;
}

/**
 * Fusiona los catálogos: cada sismo sale UNA vez, con `confirmed` (ambas redes)
 * o `reported` (una sola). La posición/magnitud del confirmado es la de USGS
 * (catálogo de referencia); EMSC-solo entra como reportado.
 */
export function mergeQuakes(usgs, emsc, tol = MATCH_TOL) {
  const used = new Set();
  const out = [];
  for (const u of usgs) {
    const m = emsc.find((e) => !used.has(e.id) && sameQuake(u, e, tol));
    if (m) used.add(m.id);
    out.push({ ...u, confirmed: Boolean(m), sources: m ? ['usgs', 'emsc'] : ['usgs'] });
  }
  for (const e of emsc) {
    if (!used.has(e.id)) out.push({ ...e, confirmed: false, sources: ['emsc'] });
  }
  return out.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
}

/**
 * Radio de afectación aproximado (km): hasta dónde el sismo se SIENTE con
 * intensidad relevante (≈MMI IV+). Tabla transparente de triage — NO es un
 * modelo sismológico (eso sería ShakeMap): es la regla auditable con la que
 * la app decide "te toca / no te toca". Un M6.5 en Mendoza NO alcanza a
 * Buenos Aires (~1.000 km): correcto con esta tabla.
 */
export function feltRadiusKm(mag, depthKm = 10) {
  let r;
  if (mag < 4.0) r = 25;
  else if (mag < 4.8) r = 60;
  else if (mag < 5.5) r = 120;
  else if (mag < 6.2) r = 250;
  else if (mag < 7.0) r = 450;
  else r = 800;
  // Un foco muy profundo (>300 km) se siente mucho menos en superficie.
  if (depthKm != null && depthKm > 300) r = Math.round(r * 0.4);
  return r;
}

/** ¿Este sismo afecta a una persona en (lat,lng)? Devuelve la distancia o null. */
export function affectsPoint(quake, lat, lng) {
  const d = haversineKm(quake.lat, quake.lng, lat, lng);
  return d <= feltRadiusKm(quake.mag, quake.depth_km) ? Math.round(d) : null;
}

// Tipos de evento GDACS → etiqueta humana (global: el vigía es de TODO el mundo).
const GDACS_TYPE = {
  EQ: 'sismo', TC: 'ciclón tropical', FL: 'inundación', VO: 'erupción volcánica',
  DR: 'sequía', WF: 'incendio forestal', TS: 'tsunami',
};

/** GDACS EVENTS4APP (GeoJSON) → desastres globales normalizados con coordenadas. */
export function parseGdacsEvents(json) {
  const out = [];
  for (const f of json?.features ?? []) {
    const p = f.properties ?? {};
    if (!p.eventtype || p.eventid == null) continue;
    const [lng, lat] = f.geometry?.coordinates ?? [];
    const level = String(p.alertlevel ?? '').toLowerCase(); // green|orange|red
    if (level === 'green' || lat == null || lng == null) continue; // verde = rutina: no es alerta
    out.push({
      id: `gdacs:${p.eventtype}:${p.eventid}`,
      source: 'gdacs',
      type: GDACS_TYPE[p.eventtype] ?? p.eventtype,
      level, // orange | red
      name: p.eventname || p.name || p.htmldescription || null,
      country: p.country ?? null,
      t: p.fromdate ?? p.todate ?? null,
      lat, lng,
      url: p.url?.report ?? null,
    });
  }
  return out;
}

/** Radio de relevancia por tipo de desastre GDACS (triage transparente, km). */
export function disasterRadiusKm(type, level) {
  const base = { 'ciclón tropical': 400, 'inundación': 150, 'erupción volcánica': 100, 'sequía': 500, 'incendio forestal': 80, 'tsunami': 500, sismo: 200 }[type] ?? 150;
  return level === 'red' ? Math.round(base * 1.5) : base;
}

/**
 * Alertas del SMN (ws.smn.gob.ar, formato de su web service) → normalizadas.
 * Tolerante por diseño: el SMN vive detrás de Cloudflare y a veces no responde;
 * un shape inesperado devuelve [] sin romper (el estado honesto va en sources_ok).
 */
export function parseSmnAlerts(json) {
  const rows = Array.isArray(json) ? json : (Array.isArray(json?.alertas) ? json.alertas : []);
  const out = [];
  for (const a of rows) {
    const title = a.titulo ?? a.title ?? a.event ?? null;
    if (!title) continue;
    out.push({
      id: `smn:${a.id ?? a.idAlerta ?? title}`,
      source: 'smn',
      title: String(title),
      severity: a.severidad ?? a.severity ?? null,
      status: a.estado ?? a.status ?? null,
      zones: a.zonas ?? a.areas ?? a.areaDesc ?? null,
      updated: a.fechaActualizacion ?? a.updated ?? a.sent ?? null,
      description: a.descripcion ?? a.description ?? null,
    });
  }
  return out;
}
