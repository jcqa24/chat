// Descarga de SIGEV todos los precios dados de alta (lo que el bot DEBERÍA encontrar).
// Lo usan "npm run precios" (sin IA) y "npm run conversar -- precios" (conversaciones con Sandra).
//
// Variables (.env): PRUEBAS_SIGEV_URL (o SIGEV_URL), SIGEV_IA_EMAIL, SIGEV_IA_PASSWORD.

require('dotenv').config({ quiet: true });

const SIGEV = (process.env.PRUEBAS_SIGEV_URL || process.env.SIGEV_URL || '').replace(/\/+$/, '');
const SERVICIOS = { 1: 'VIP', 2: 'XP', 3: 'CL' };

// SIGEV limita la API a 60 peticiones por minuto por usuario: se manda una por segundo como máximo
// y, si aun así responde 429 ("Too Many Attempts"), se espera lo que pide y se reintenta.
const PAUSA_MS = Number(process.env.PRUEBAS_SIGEV_PAUSA_MS ?? 1050);
let siguienteTurno = 0;
async function esperarTurno() {
  const ahora = Date.now();
  const turno = Math.max(ahora, siguienteTurno);
  siguienteTurno = turno + PAUSA_MS;
  if (turno > ahora) await new Promise((r) => setTimeout(r, turno - ahora));
}

async function http(method, url, { headers = {}, body } = {}) {
  for (let intento = 1; ; intento++) {
    await esperarTurno();
    const resp = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (resp.status === 429 && intento < 10) {
      const segundos = Number(resp.headers.get('retry-after')) || 15;
      siguienteTurno = Math.max(siguienteTurno, Date.now() + segundos * 1000);
      await resp.arrayBuffer().catch(() => {});
      continue;
    }
    const texto = await resp.text();
    let json;
    try { json = JSON.parse(texto); } catch { json = texto; }
    return { statusCode: resp.status, body: json };
  }
}

/** Entra a SIGEV con el usuario de IA. Devuelve { token, sigev(ruta, body) }. */
async function conectar() {
  const { SIGEV_IA_EMAIL: email, SIGEV_IA_PASSWORD: password } = process.env;
  if (!SIGEV || !email || !password) throw new Error('Faltan PRUEBAS_SIGEV_URL, SIGEV_IA_EMAIL o SIGEV_IA_PASSWORD en .env');
  const login = await http('POST', `${SIGEV}/api/ialogin`, { body: { email, password } });
  const token = login.body?.token;
  if (!token) throw new Error(`No se pudo entrar a SIGEV (${SIGEV}): ${JSON.stringify(login.body).slice(0, 200)}`);
  const sigev = (ruta, body) => http('POST', `${SIGEV}/api/${ruta}`, { headers: { Authorization: `Bearer ${token}` }, body });
  return { token, sigev };
}

/** Todos los precios y catálogos: { filas, catTramites, catEntidades, catVehiculos } */
async function descargarCatalogo(sigev) {
  const descargar = async (ruta) => {
    const r = await sigev(ruta, {});
    if (r.body?.success !== true) throw new Error(`${ruta}: ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body.data;
  };
  const costos = await descargar('getCatalogoCostosTramites');
  const licencias = await descargar('getCatalogoCostosLicencias');
  const verificacion = await descargar('getCatalogoCostosVerificacion');
  const catTramites = await descargar('getCatalogoTramite');
  const catEntidades = await descargar('getCatalogoEntidad');
  const catVehiculos = await descargar('getCatalogoTipoVehiculo');
  // Licencias (18, 43, 44) y verificación (17) se cotizan con sus propias tablas; si aparecen en la tabla
  // general (rmm_costos) getCosto nunca las usa: se apartan como "ignorados" para reportarlas.
  // Trámites desactivados en SIGEV (no están en getCatalogoTramite) pueden tener precios: getCosto los rechaza.
  const CON_TABLA_PROPIA = [17, 18, 43, 44];
  const activos = new Set(catTramites.map((t) => Number(t.id)));
  const ignorados = [];
  const filas = [];
  for (const f of costos) {
    const id = Number(f.id_tipotramite);
    if (!activos.has(id)) ignorados.push({ ...f, motivo: 'Trámite desactivado en SIGEV (cat_tramite.tramite_estatus = 0) pero con precios activos: getCosto lo rechaza' });
    else if (CON_TABLA_PROPIA.includes(id)) ignorados.push({ ...f, motivo: 'Precio en la tabla general (rmm_costos): getCosto nunca lo usa para este trámite (usa la tabla con vigencia/modelo)' });
    else filas.push(f);
  }
  for (const f of [...licencias, ...verificacion]) {
    if (activos.has(Number(f.id_tipotramite))) filas.push(f);
    else ignorados.push({ ...f, motivo: 'Trámite desactivado en SIGEV pero con precios activos' });
  }
  return { filas, ignorados, catTramites, catEntidades, catVehiculos };
}

/**
 * Agrupa los precios por trámite + vehículo + estado (+ vigencia / rango de modelo y voluntaria).
 * Cada grupo trae servicios: Map(id_servicio → Set de precios).
 */
function agrupar(filas) {
  const grupos = new Map();
  for (const f of filas) {
    const clave = [f.id_tipotramite, f.id_tipovehiculo, f.id_entidad, f.id_vigencia ?? '', f.idmodelo_min ?? '', f.idmodelo_max ?? '', f.voluntaria ?? ''].join('|');
    if (!grupos.has(clave)) grupos.set(clave, { ...f, servicios: new Map() });
    const g = grupos.get(clave);
    const id = Number(f.id_tiposervicio);
    if (!g.servicios.has(id)) g.servicios.set(id, new Set());
    g.servicios.get(id).add(Number(f.costo));
  }
  return [...grupos.values()];
}

const vigenciaTexto = (id) => (Number(id) === 99 ? 'permanente' : `${id} ${Number(id) === 1 ? 'año' : 'años'}`);

/** Año de ejemplo dentro del rango de modelos de una verificación */
const anioDe = (g) => String(Math.floor((Math.max(Number(g.modelo_min), 1950) + Math.min(Number(g.modelo_max), 2029)) / 2));

const describir = (g) => [
  g.tramite_nombre, g.entidad_alias, g.tipovehiculo_alias,
  g.id_vigencia != null ? vigenciaTexto(g.id_vigencia) : null,
  g.idmodelo_min != null ? `modelo ${g.modelo_min}-${g.modelo_max}${Number(g.voluntaria) ? ' voluntaria' : ''}` : null,
].filter(Boolean).join(' · ');

/**
 * Filtra por tipo de trámite y estado. Cada filtro acepta ids o alias separados por coma:
 * { tramite: 'LICEN,VOE', estado: '9,EDOMEX' }. Sin filtro, deja todo.
 */
function filtrar(filas, { tramite, estado } = {}) {
  const lista = (v) => (v ? String(v).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : null);
  const tramites = lista(tramite);
  const estados = lista(estado);
  const coincide = (valores, id, alias) => !valores || valores.includes(String(id)) || valores.includes(String(alias).toUpperCase());
  return filas.filter((f) => coincide(tramites, f.id_tipotramite, f.tramite_alias) && coincide(estados, f.id_entidad, f.entidad_alias));
}

/** Lista para elegir filtros: trámites (id, alias, nombre, cuántos precios) */
function listarTramites(filas) {
  const porTramite = new Map();
  for (const f of filas) {
    const id = Number(f.id_tipotramite);
    if (!porTramite.has(id)) porTramite.set(id, { id, alias: f.tramite_alias, nombre: f.tramite_nombre, precios: 0, estados: new Set() });
    const t = porTramite.get(id);
    t.precios++;
    t.estados.add(f.entidad_alias);
  }
  return [...porTramite.values()].sort((a, b) => a.id - b.id);
}

function imprimirTramites(filas) {
  console.log('Tipos de trámite con precio en SIGEV (usa el id o el alias en --tramite, varios separados por coma):\n');
  for (const t of listarTramites(filas)) {
    console.log(`  ${String(t.id).padStart(3)}  ${String(t.alias).padEnd(16)} ${String(t.precios).padStart(3)} precios  ${t.nombre}  (${[...t.estados].join(', ')})`);
  }
}

module.exports = {
  SIGEV, SERVICIOS, http, conectar, descargarCatalogo, agrupar, filtrar, listarTramites, imprimirTramites,
  vigenciaTexto, anioDe, describir,
};
