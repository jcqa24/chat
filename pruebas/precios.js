#!/usr/bin/env node
// Prueba de precios: revisa que el sub-workflow cotizar_tramite de n8n encuentre bien TODOS los precios de SIGEV.
//
//   npm run precios
//   npm run precios -- --tramite LICEN          (por tipo de trámite: id o alias, varios con coma: LICEN,VOE)
//   npm run precios -- --estado CDMX --tramite 18
//   npm run precios -- --lista                  (tipos de trámite con precio en SIGEV)
//   npm run precios -- --no-abrir               (no abre el reporte en el navegador)
//
// 1. Entra a SIGEV (/api/ialogin) y descarga todos los precios dados de alta (catálogos de costos).
// 2. Revisa que "Traducir a IDs" reconozca cada trámite, estado y vehículo por su nombre y alias.
// 3. Por cada combinación corre el código REAL de los nodos (n8n/traducir-a-ids.js y n8n/respuesta-precio.js)
//    contra /api/getCosto, con y sin servicio, y compara el precio con el catálogo.
// 4. Imprime un resumen y guarda un CSV con todo en pruebas/resultados/.
//
// Variables (.env): PRUEBAS_SIGEV_URL (o SIGEV_URL), SIGEV_IA_EMAIL, SIGEV_IA_PASSWORD.
// Solo consulta: no crea nada en SIGEV.

const fs = require('fs');
const path = require('path');
const { SIGEV, SERVICIOS, http, conectar, descargarCatalogo, agrupar, filtrar, imprimirTramites, vigenciaTexto, anioDe, describir } = require('./sigev-catalogo');
const { guardarReporte } = require('./reporte');

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const FILTROS = { tramite: opcion('tramite'), estado: opcion('estado') };
const FILTRADO = Boolean(FILTROS.tramite || FILTROS.estado);

const color = (c, t) => (process.stdout.isTTY ? `[${c}m${t}[0m` : t);
const verde = (t) => color(32, t);
const rojo = (t) => color(31, t);
const amarillo = (t) => color(33, t);
const gris = (t) => color(90, t);
const negritas = (t) => color(1, t);

let token;
let sigev;

// ---------- Código real de los nodos de n8n ----------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const leerNodo = (archivo) => new AsyncFunction('$', '$input', fs.readFileSync(path.join(__dirname, '..', 'n8n', archivo), 'utf8'));
const nodoTraducir = leerNodo('traducir-a-ids.js');
const nodoRespuesta = leerNodo('respuesta-precio.js');

// Como en n8n: this.helpers.httpRequest lanza error si SIGEV no responde 2xx
const helpers = {
  async httpRequest({ method, url, headers, body }) {
    const r = await http(method, url, { headers, body });
    if (r.statusCode < 200 || r.statusCode >= 300) {
      const e = new Error(`HTTP ${r.statusCode}`); e.httpCode = r.statusCode; throw e;
    }
    return r.body;
  },
};

/** Lo que haría el sub-workflow con lo que manda el agente: { traducido, respuesta } */
async function cotizar(entrada) {
  const nodos = { 'Cuando lo llama el agente': entrada, 'Configuración': {} }; // sin chat: no se registra nada
  const $ = (nombre) => ({ first: () => ({ json: nodos[nombre] }), item: { json: nodos[nombre] } });
  const traducido = (await nodoTraducir.call({ helpers }, $, { first: () => ({ json: entrada }) }))[0].json;
  if (!traducido.ok) return { traducido, respuesta: null };
  traducido.sigevUrl = SIGEV; // el código trae la URL de producción; aquí se prueba contra PRUEBAS_SIGEV_URL
  nodos['Traducir a IDs'] = traducido;
  nodos['Entrar a SIGEV'] = { token };
  const consultar = await sigev('getCosto', traducido.body); // nodo "Consultar costo" (Full Response)
  const respuesta = (await nodoRespuesta.call({ helpers }, $, { first: () => ({ json: consultar }) }))[0].json;
  // Para el reporte: qué respondió SIGEV (ayuda a distinguir un error pasajero de un precio que no existe)
  respuesta.mensaje = `${respuesta.mensaje ?? ''} [getCosto HTTP ${consultar.statusCode}${consultar.body?.message ? `: ${consultar.body.message}` : ''}]`;
  return { traducido, respuesta };
}

// ---------- Casos ----------
const minus = (s) => String(s ?? '').toLowerCase();

function entradaDe(g, servicio) {
  const e = {
    tramite: minus(g.tramite_nombre),
    estado: g.entidad_nombre,
    vehiculo: minus(g.tipovehiculo_alias),
    conversationId: 0,
  };
  if (servicio) e.servicio = servicio;
  if (g.id_vigencia != null) e.vigencia = vigenciaTexto(g.id_vigencia);
  if (g.idmodelo_min != null) {
    e.anio = anioDe(g);
    e.voluntaria = Number(g.voluntaria) === 1 ? 'sí' : 'no';
  }
  return e;
}

const resultados = []; // { tipo, caso, esperado, obtenido, ok, detalle }
const registrar = (r) => resultados.push(r);

async function probarGrupo(g) {
  const disponibles = [...g.servicios.keys()];
  const precioDe = (id) => [...g.servicios.get(id)];
  const base = describir(g);

  // SIGEV con dos precios distintos para la misma combinación: el bot no adivina (no da precio)
  for (const id of disponibles) {
    if (precioDe(id).length > 1) {
      registrar({ tipo: 'catálogo', caso: `${base} · ${SERVICIOS[id]}`, esperado: 'un solo precio', obtenido: precioDe(id).join(' / '), ok: false, detalle: 'SIGEV tiene varios precios para la misma combinación' });
    }
  }

  // 1) Con cada servicio disponible: debe dar ese precio
  for (const id of disponibles) {
    if (precioDe(id).length > 1) continue;
    const esperado = precioDe(id)[0];
    const caso = `${base} · ${SERVICIOS[id]}`;
    try {
      const { traducido, respuesta } = await cotizar(entradaDe(g, SERVICIOS[id]));
      if (!traducido.ok) {
        registrar({ tipo: 'con servicio', caso, esperado, obtenido: '-', ok: false, detalle: `No traduce: ${traducido.mensaje}` });
        continue;
      }
      const ok = respuesta.encontrado === true && Number(respuesta.costo) === esperado && respuesta.servicio === SERVICIOS[id];
      registrar({ tipo: 'con servicio', caso, esperado, obtenido: respuesta.costo ?? '-', ok, detalle: ok ? '' : respuesta.mensaje });
    } catch (err) {
      registrar({ tipo: 'con servicio', caso, esperado, obtenido: '-', ok: false, detalle: `Error: ${err.message}` });
    }
  }

  // 2) Sin decir servicio: un servicio → ese precio; varios → ofrece todos con su precio
  const unicos = disponibles.filter((id) => precioDe(id).length === 1);
  const caso = `${base} · sin servicio`;
  try {
    const { traducido, respuesta } = await cotizar(entradaDe(g, null));
    if (!traducido.ok) {
      registrar({ tipo: 'sin servicio', caso, esperado: '-', obtenido: '-', ok: false, detalle: `No traduce: ${traducido.mensaje}` });
      return;
    }
    if (unicos.length === 1) {
      const esperado = precioDe(unicos[0])[0];
      const ok = respuesta.encontrado === true && Number(respuesta.costo) === esperado && respuesta.servicio === SERVICIOS[unicos[0]];
      registrar({ tipo: 'sin servicio', caso, esperado: `${SERVICIOS[unicos[0]]} ${esperado}`, obtenido: `${respuesta.servicio ?? '-'} ${respuesta.costo ?? '-'}`, ok, detalle: ok ? '' : respuesta.mensaje });
    } else if (unicos.length > 1) {
      const ofrecidos = new Map((respuesta.alternativas ?? []).map((a) => [a.servicio, Number(a.costo)]));
      const esperado = unicos.map((id) => `${SERVICIOS[id]} ${precioDe(id)[0]}`).join(', ');
      const obtenido = [...ofrecidos].map(([s, c]) => `${s} ${c}`).join(', ') || '-';
      const ok = unicos.every((id) => ofrecidos.get(SERVICIOS[id]) === precioDe(id)[0]) && ofrecidos.size === unicos.length;
      registrar({ tipo: 'sin servicio', caso, esperado, obtenido, ok, detalle: ok ? '' : respuesta.mensaje });
    }
  } catch (err) {
    registrar({ tipo: 'sin servicio', caso, esperado: '-', obtenido: '-', ok: false, detalle: `Error: ${err.message}` });
  }
}

// 3) Combinación que NO existe: debe ofrecer asesor, sin inventar precio
async function probarInexistente(tramite, entidad, vehiculo) {
  const caso = `${tramite.nombre} · ${entidad.alias} · ${vehiculo.alias} (no existe en SIGEV)`;
  const entrada = { tramite: minus(tramite.nombre), estado: entidad.nombre, vehiculo: minus(vehiculo.alias), conversationId: 0 };
  if ([18, 43, 44].includes(tramite.id)) entrada.vigencia = '3 años';
  if (tramite.id === 17) { entrada.anio = '2015'; entrada.voluntaria = 'no'; }
  try {
    const { traducido, respuesta } = await cotizar(entrada);
    if (!traducido.ok) {
      registrar({ tipo: 'no existe', caso, esperado: 'asesor', obtenido: '-', ok: false, detalle: `No traduce: ${traducido.mensaje}` });
      return;
    }
    const ok = respuesta.encontrado === false && !respuesta.costo && !(respuesta.alternativas ?? []).length && /asesor/i.test(respuesta.mensaje);
    registrar({ tipo: 'no existe', caso, esperado: 'asesor, sin precio', obtenido: respuesta.costo ?? (respuesta.alternativas?.length ? 'alternativas' : 'asesor'), ok, detalle: ok ? '' : respuesta.mensaje });
  } catch (err) {
    registrar({ tipo: 'no existe', caso, esperado: 'asesor', obtenido: '-', ok: false, detalle: `Error: ${err.message}` });
  }
}

// 4) Catálogos: ¿Traducir a IDs reconoce cada trámite, estado y vehículo por su nombre y su alias?
async function probarCatalogos(catTramites, catEntidades, catVehiculos) {
  const base = { tramite: 'licencia de manejo', estado: 'cdmx', vehiculo: 'auto', vigencia: '3 años', conversationId: 0 };
  const traducir = async (cambios) => {
    const nodos = { 'Cuando lo llama el agente': { ...base, ...cambios } };
    const $ = (n) => ({ first: () => ({ json: nodos[n] }) });
    return (await nodoTraducir.call({ helpers }, $, {}))[0].json;
  };
  for (const t of catTramites) {
    for (const nombre of new Set([t.nombre, t.alias])) {
      const r = await traducir({ tramite: nombre, anio: '2015', voluntaria: 'no' });
      const ok = r.body?.id_tramite === t.id || r.resumen?.id_tramite === t.id;
      registrar({ tipo: 'catálogo trámite', caso: `"${nombre}"`, esperado: t.id, obtenido: r.body?.id_tramite ?? r.resumen?.id_tramite ?? '-', ok, detalle: ok ? '' : r.mensaje });
    }
  }
  for (const e of catEntidades) {
    for (const nombre of new Set([e.nombre, e.alias])) {
      const r = await traducir({ estado: nombre });
      const ok = r.body?.id_entidad === e.id;
      registrar({ tipo: 'catálogo estado', caso: `"${nombre}"`, esperado: e.id, obtenido: r.body?.id_entidad ?? '-', ok, detalle: ok ? '' : r.mensaje });
    }
  }
  for (const v of catVehiculos) {
    for (const nombre of new Set([v.nombre, v.alias])) {
      const r = await traducir({ vehiculo: nombre });
      const ok = r.body?.id_tipovehiculo === v.id;
      registrar({ tipo: 'catálogo vehículo', caso: `"${nombre}"`, esperado: v.id, obtenido: r.body?.id_tipovehiculo ?? '-', ok, detalle: ok ? '' : r.mensaje });
    }
  }
}

// 5) Formas comunes de pedir un trámite (lo que escribiría la gente / Sandra)
const FRASES = [
  ['reposición de tarjeta de circulación', 11], ['perdí mi tarjeta de circulación', 11], ['me robaron la tarjeta', 11],
  ['reimpresión de tarjeta de circulación', 40], ['reimprimir tarjeta', 40],
  ['renovación de tarjeta de circulación', 9], ['tarjeta vencida', 9],
  ['licencia', 18], ['licencia de conducir', 18], ['licencia de manejo', 18], ['reposición de licencia', 30],
  ['permiso para circular sin placas', 20], ['baja y alta de placas', 4], ['cambio de propietario', 10],
  ['alta de placas', 7], ['baja de placas', 6], ['verificación', 17], ['reemplacamiento', 5], ['vehículo nuevo', 8],
  ['vehículo de otra entidad', 3], ['alta de vehículo de otra entidad', 3], ['alta de veiculo de otra entidad', 3],
  ['emplacar un carro de otro estado', 3], ['alta de placas de un auto de otro estado', 3], ['vehiculo foraneo', 3],
  ['trámite de vehículo de otra entidad', 3], ['alta de placas para vehículo nuevo', 8], ['cambio de propietario de mi carro', 10],
  ['licencia de manejo sin constancia', 44], ['vehículo extranjero', 29],
];
async function probarFrases() {
  for (const [frase, id] of FRASES) {
    const nodos = { 'Cuando lo llama el agente': { tramite: frase, estado: 'cdmx', vehiculo: 'auto', vigencia: '3 años', anio: '2015', voluntaria: 'no' } };
    const $ = (n) => ({ first: () => ({ json: nodos[n] }) });
    const r = (await nodoTraducir.call({ helpers }, $, {}))[0].json;
    const obtenido = r.body?.id_tramite ?? r.resumen?.id_tramite ?? null;
    registrar({ tipo: 'frase', caso: `"${frase}"`, esperado: id, obtenido: obtenido ?? '-', ok: obtenido === id, detalle: obtenido === id ? '' : r.mensaje ?? '' });
  }
}

// ---------- Correr ----------
async function enParalelo(tareas, n) {
  let i = 0;
  let hechas = 0;
  const trabajador = async () => {
    while (i < tareas.length) {
      const tarea = tareas[i++];
      await tarea();
      hechas++;
      if (process.stdout.isTTY) process.stdout.write(`\r  ${hechas}/${tareas.length} combinaciones`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tareas.length) }, trabajador));
  if (process.stdout.isTTY) process.stdout.write('\n');
}

(async () => {
  console.log(negritas(`Prueba de precios contra ${SIGEV}`));
  ({ token, sigev } = await conectar());
  console.log(gris('  SIGEV permite 60 consultas por minuto: la prueba completa tarda unos 15-20 minutos'));
  const { filas: todas, ignorados, catTramites, catEntidades, catVehiculos } = await descargarCatalogo(sigev);
  if (args.includes('--lista')) {
    imprimirTramites(todas);
    process.exit(0);
  }
  // Precios que SIGEV tiene dados de alta pero nunca puede devolver: datos para limpiar en SIGEV
  for (const f of filtrar(ignorados, FILTROS)) {
    registrar({
      tipo: 'datos de SIGEV', caso: `${f.tramite_nombre} · ${f.entidad_alias} · ${f.tipovehiculo_alias} · ${f.tiposervicio_nombre}`,
      esperado: 'precio utilizable', obtenido: `$${f.costo}`, ok: false, detalle: f.motivo,
    });
  }
  const filas = filtrar(todas, FILTROS);
  if (!filas.length) {
    console.error(rojo('No hay precios con esos filtros. Usa "npm run precios -- --lista" para ver los trámites.'));
    process.exit(1);
  }
  const grupos = agrupar(filas);
  console.log(gris(`  ${filas.length} precios en SIGEV → ${grupos.length} combinaciones de trámite, estado y vehículo`));

  if (!FILTRADO) {
    console.log('  Revisando catálogos y frases...');
    await probarCatalogos(catTramites, catEntidades, catVehiculos);
    await probarFrases();
  }

  console.log('  Revisando precios...');
  const tareas = grupos.map((g) => () => probarGrupo(g));
  // Una combinación inexistente por trámite: un estado donde ese trámite no tiene precio
  const tramitesConPrecio = [...new Set(filas.map((f) => Number(f.id_tipotramite)))];
  for (const idT of tramitesConPrecio) {
    const t = catTramites.find((x) => x.id === idT);
    const conPrecio = new Set(filas.filter((f) => Number(f.id_tipotramite) === idT).map((f) => Number(f.id_entidad)));
    const e = catEntidades.find((x) => !conPrecio.has(x.id));
    const v = catVehiculos.find((x) => x.id === 1);
    if (t && e && v) tareas.push(() => probarInexistente(t, e, v));
  }
  await enParalelo(tareas, 2);

  // ---------- Reporte ----------
  const tipos = [...new Set(resultados.map((r) => r.tipo))];
  console.log(`\n${negritas('Resumen')}`);
  for (const tipo of tipos) {
    const rs = resultados.filter((r) => r.tipo === tipo);
    const bien = rs.filter((r) => r.ok).length;
    const marca = bien === rs.length ? verde('✔') : rojo('✘');
    console.log(`  ${marca} ${tipo.padEnd(18)} ${bien}/${rs.length}`);
  }
  const fallas = resultados.filter((r) => !r.ok);
  if (fallas.length) {
    console.log(`\n${negritas(`Fallas (${fallas.length})`)}`);
    for (const f of fallas.slice(0, 60)) {
      console.log(`  ${rojo('✘')} ${amarillo(f.tipo)} ${f.caso}`);
      console.log(gris(`      esperado: ${f.esperado} · obtenido: ${f.obtenido}${f.detalle ? ` · ${String(f.detalle).slice(0, 160)}` : ''}`));
    }
    if (fallas.length > 60) console.log(gris(`  … y ${fallas.length - 60} más en el CSV`));
  }

  const filtroTexto = FILTRADO ? ` · filtro: ${[FILTROS.tramite && `trámite ${FILTROS.tramite}`, FILTROS.estado && `estado ${FILTROS.estado}`].filter(Boolean).join(', ')}` : '';
  const reporte = guardarReporte({
    nombre: 'precios',
    titulo: 'Prueba de precios (cotizar_tramite sin IA)',
    subtitulo: `SIGEV ${SIGEV}${filtroTexto}`,
    resultados,
    abrir: !args.includes('--no-abrir'),
  });
  console.log(gris(`\nReporte: ${reporte.html}\nCSV:     ${reporte.csv}`));
  process.exit(fallas.length ? 1 : 0);
})().catch((err) => { console.error(rojo(err.stack || err.message)); process.exit(1); });
