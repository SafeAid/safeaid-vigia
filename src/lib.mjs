// src/lib.mjs — núcleo PURO del vigía de eventos de SafeAid.
// El vigía es el canal RÁPIDO (minutos) de la app: sismos confirmados por doble
// red (USGS↔EMSC) + alertas oficiales. Copia standalone del motor principal
// (repo privado); mantener en sincronía ante cambios de tolerancias o radios.
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
export function parseWmoWarnings(json) {
  const out = [];
  for (const w of json?.items ?? []) {
    // El feed usa capURL en la mayoría de los ítems y url en algunos; el
    // prefijo alpha-2 del path es el emisor nacional ("fr-meteofrance-…").
    const iso2 = /^([a-z]{2})-/i.exec(w.capURL ?? w.url ?? '')?.[1];
    const iso3 = iso2to3(iso2);
    if (!iso3 || !w.event) continue;
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
