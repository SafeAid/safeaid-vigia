/**
 * Vigía de eventos de SafeAid (spec 17 §1/§4/§7.1) — el canal RÁPIDO, global.
 *
 * Junta, en segundos y de fuentes públicas mundiales:
 *  - Sismos: USGS + EMSC (últimas 24 h), fusionados con confirmación de doble
 *    red (mismas tolerancias que sismo-dual §5.3) y radio de afectación.
 *  - Desastres: GDACS naranja/rojo (ciclones, inundaciones, erupciones…) con
 *    coordenadas y radio de relevancia.
 *  - Alertas meteorológicas OFICIALES de ~130 países: feed mundial de la OMM
 *    (severeweather.wmo.int) — «el SMN de cada país» en una integración.
 *  - SMN Argentina directo como refuerzo (mejor detalle de zonas), tolerante:
 *    si no responde, se declara y no rompe nada.
 *
 * Salida: data/v2/vigia.json — incluye la MATRIZ DE COBERTURA por país
 * (pedido de Javier: «que sepan qué tipos de eventos cubrimos»), derivada de
 * lo efectivamente observado en esta corrida, no de promesas.
 *
 * Nunca bloquea: cada fuente caída queda declarada en sources_ok.
 * Uso: node scripts/vigia-run.mjs  ·  npm run vigia
 */
import dns from 'node:dns'
import { writeFileSync, renameSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseUsgsGeojson, parseEmscFdsn, mergeQuakes, feltRadiusKm,
  parseGdacsEvents, disasterRadiusKm, parseWmoWarnings, wmoByCountry, parseSmnAlerts,
  parseWmoWfs,
} from './src/lib.mjs'

dns.setDefaultResultOrder('ipv4first')

const root = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(root, 'vigia.json')
const COUNTRIES = JSON.parse(readFileSync(path.join(root, 'data', 'countries.json'), 'utf8'))

const log = (m) => console.error(`[vigia] ${m}`)

async function getJson(url, { timeoutMs = 25_000, headers = {} } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'SafeAid-vigia/1.0 (safeaid.io; javier@safeaid.io)', accept: 'application/json', ...headers },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function tryFetch(name, fn) {
  try {
    const t0 = Date.now()
    const value = await fn()
    log(`${name}: ok (${Date.now() - t0} ms)`)
    return { ok: true, value }
  } catch (e) {
    log(`${name}: caída (${e.message}) — se declara y se sigue`)
    return { ok: false, value: null, error: String(e.message).slice(0, 120) }
  }
}

async function main() {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 19)

  // WFS de SWIC con el POLÍGONO de cada alerta (pedido de Javier: alertas por
  // ciudad, no por país). Pesado (~27 MB), por eso timeout largo y tolerante.
  const WFS_ZONAS = 'https://severeweather.wmo.int/f/wfs?request=GetFeature&version=1.1.0'
    + '&typeName=local_postgis:postgis_geojsons'
    + `&cql_filter=${encodeURIComponent("row_type='POLYGON'")}&outputFormat=json`

  const [usgs, emsc, gdacs, wmo, smn, wfs] = await Promise.all([
    tryFetch('usgs', () => getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson')),
    tryFetch('emsc', () => getJson(`https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=800&minmag=2.5&starttime=${since}`)),
    tryFetch('gdacs', () => getJson('https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP')),
    tryFetch('wmo', () => getJson('https://severeweather.wmo.int/v2/json/wmo_all.json')),
    tryFetch('smn', () => getJson('https://ws.smn.gob.ar/alerts/type/AL')),
    tryFetch('wmo-zonas', () => getJson(WFS_ZONAS, { timeoutMs: 120_000 })),
  ])

  const quakesAll = mergeQuakes(
    usgs.ok ? parseUsgsGeojson(usgs.value) : [],
    emsc.ok ? parseEmscFdsn(emsc.value) : [],
  )
  // Señal, no censo: para la app importan los sismos que alguien puede sentir.
  const quakes = quakesAll
    .filter((q) => q.mag >= 4.0 || (q.confirmed && q.mag >= 3.5))
    .map((q) => ({ ...q, felt_radius_km: feltRadiusKm(q.mag, q.depth_km) }))

  const disasters = (gdacs.ok ? parseGdacsEvents(gdacs.value) : [])
    .map((d) => ({ ...d, radius_km: disasterRadiusKm(d.type, d.level) }))

  // Primaria: WFS (vigentes + polígono). Respaldo: wmo_all filtrado por
  // vigencia (hallazgo 29-sep: es un archivo rodante lleno de vencidas).
  const wmoWarnings = wfs.ok ? parseWmoWfs(wfs.value)
    : wmo.ok ? parseWmoWarnings(wmo.value) : []
  const official = wmoByCountry(wmoWarnings)
  const smnAlerts = smn.ok ? parseSmnAlerts(smn.value) : []

  // ---- Matriz de cobertura por país (pedido de Javier): derivada de lo
  // OBSERVADO, no declarada a mano. Un país "tiene meteo oficial" si su
  // servicio aparece en el feed OMM (con alertas hoy o históricamente sería
  // mejor — v1: presencia hoy o refuerzo directo conocido).
  const DIRECT_FEEDS = { ARG: 'smn' } // refuerzos directos integrados además de la OMM
  // Un país "tiene meteo oficial" si su servicio apareció en el feed OMM en ESTA
  // corrida O en cualquiera anterior (un país sin alertas hoy no pierde cobertura).
  const wmoCountries = new Set(Object.keys(official))
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'))
    for (const iso3 of prev.wmo_countries_seen ?? []) wmoCountries.add(iso3)
    for (const [iso3, c] of Object.entries(prev.coverage ?? {})) {
      if (c.meteo_oficial === 'wmo') wmoCountries.add(iso3)
    }
  } catch { /* primera corrida: sin memoria previa */ }
  const coverage = {}
  for (const c of COUNTRIES) {
    coverage[c.iso3] = {
      sismos: 'global',                      // USGS+EMSC cubren el planeta
      desastres: 'global',                   // GDACS cubre el planeta
      meteo_oficial: DIRECT_FEEDS[c.iso3] ?? (wmoCountries.has(c.iso3) ? 'wmo' : null),
      indice: true,                          // el STC cubre los 197 del catálogo
    }
  }

  const out = {
    generated_utc: new Date().toISOString(),
    window_hours: 24,
    sources_ok: {
      usgs: usgs.ok, emsc: emsc.ok, gdacs: gdacs.ok, wmo: wmo.ok, smn: smn.ok,
      wmo_zonas: wfs.ok,
      ...(smn.ok ? {} : { smn_error: smn.error }),
    },
    quakes,
    disasters,
    official_by_country: official,
    smn_ar: smnAlerts,
    coverage,
    wmo_countries_seen: [...wmoCountries].sort(),
  }
  writeFileSync(`${OUT}.tmp`, JSON.stringify(out))
  renameSync(`${OUT}.tmp`, OUT)
  const kb = (JSON.stringify(out).length / 1024).toFixed(0)
  const conZonas = wmoWarnings.filter((w) => w.zones?.length).length
  log(`listo: ${quakes.length} sismos (${quakes.filter((q) => q.confirmed).length} confirmados) · ${disasters.length} desastres GDACS · ${wmoWarnings.length} alertas oficiales OMM en ${wmoCountries.size} países (${conZonas} con zona) · ${smnAlerts.length} SMN → vigia.json (${kb} KB)`)
}

main().catch((e) => {
  console.error(`[vigia] ERROR no fatal: ${e.message}`)
  process.exitCode = 0 // el vigía jamás rompe una publicación
})
