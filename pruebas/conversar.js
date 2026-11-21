#!/usr/bin/env node
// Platica con Sandra por ti: abre el chat como un cliente nuevo, manda los mensajes de un escenario,
// espera las respuestas (de n8n y del servidor) e imprime la conversación y si se cumplió el flujo.
//
//   npm run conversar -- licencia-acepta
//   npm run conversar -- todos --veces 3
//   npm run conversar -- licencia-acepta --link https://mi-chat.up.railway.app/IGxxxxxx
//   npm run conversar -- lista
//   npm run conversar -- licencia-acepta --navegador            (abre Chrome y escribe ahí, para verlo)
//   npm run conversar -- licencia-acepta --navegador --celular  (igual, con pantalla de celular)
//   npm run conversar -- precios --navegador --tramite 18       (precios de SIGEV: una conversación por precio)
//   npm run conversar -- precios --tramite LICEN,VOE --estado EDOMEX
//   npm run conversar -- precios --tramite VOE --directo        (todo en un mensaje; sin --directo platica paso a paso)
//   npm run conversar -- tramites                                (tipos de trámite con precio, para --tramite)
//
// Al final se abre un reporte HTML con lo que pasó y falló (y cada conversación); --no-abrir para no abrirlo.
//
// Con --navegador la ventana se queda abierta hasta que la cierres y entonces sigue la siguiente
// conversación (--sin-esperar: se cierra sola a los 4 s). Filtros de "precios": --tramite (id o alias),
// --estado (id o alias) y --limite N. Necesita SIGEV_IA_EMAIL / SIGEV_IA_PASSWORD en .env.
//
// El link es un link de referido de cualquier influencer (como los que da el CRM). Se puede dejar
// en .env como PRUEBAS_LINK. Cada corrida abre una conversación nueva (cliente "prueba-…").
// Ojo: contra Railway son conversaciones reales (cuentan en estadísticas y gastan tokens de la IA).

require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { io } = require('socket.io-client');
const ESCENARIOS = require('./escenarios');
const { guardarReporte } = require('./reporte');

const args = process.argv.slice(2);
const opcion = (nombre, porDefecto) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};
const LINK = opcion('link', process.env.PRUEBAS_LINK);
const VECES = Math.max(1, Number(opcion('veces', 1)) || 1);
const SILENCIO_MS = Number(opcion('silencio', 6000)); // sin mensajes nuevos este tiempo = Sandra terminó de contestar
const MAX_ESPERA_MS = 90000;
const MAX_TURNOS = 8; // escenarios naturales: mensajes del cliente para llegar al precio
const NAVEGADOR = args.includes('--navegador');
const CELULAR = args.includes('--celular');
const ESPERAR_VENTANA = NAVEGADOR && !args.includes('--sin-esperar') && process.env.PRUEBAS_OCULTO !== '1';

// Con --navegador se abre Chrome visible: el cliente escribe en la página real y tú ves la conversación.
// Las revisiones se hacen igual, con una conexión aparte a la misma conversación.
let navegador = null; // { browser, contextoBase }: uno solo para todas las conversaciones
async function abrirNavegador() {
  if (navegador) return navegador;
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    throw new Error('Falta Playwright: corre "npm install" y luego "npx playwright install chromium"');
  }
  // PRUEBAS_OCULTO=1: mismo flujo en el navegador, pero sin abrir ventana
  const browser = await playwright.chromium.launch({ headless: process.env.PRUEBAS_OCULTO === '1' });
  const contextoBase = CELULAR ? playwright.devices['iPhone 13'] : { viewport: { width: 1100, height: 800 } };
  navegador = { browser, contextoBase };
  // Si cierras todo Chrome, la siguiente conversación abre uno nuevo
  browser.once('disconnected', () => { navegador = null; });
  return navegador;
}

const color = (c, t) => (process.stdout.isTTY ? `\x1b[${c}m${t}\x1b[0m` : t);
const gris = (t) => color(90, t);
const verde = (t) => color(32, t);
const rojo = (t) => color(31, t);
const azul = (t) => color(36, t);
const amarillo = (t) => color(33, t);
const negritas = (t) => color(1, t);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function uso(error) {
  if (error) console.error(rojo(error) + '\n');
  console.log('Uso: npm run conversar -- <escenario|todos|precios|tramites|lista> [--navegador] [--celular] [--veces N]');
  console.log('       [--tramite LICEN,VOE] [--estado CDMX] [--limite N] [--link URL] [--sin-esperar] [--no-abrir]\n');
  console.log('Escenarios:');
  for (const [nombre, e] of Object.entries(ESCENARIOS)) console.log(`  ${nombre.padEnd(20)} ${gris(e.descripcion)}`);
  process.exit(error ? 1 : 0);
}

// Abre el chat como cliente nuevo y devuelve helpers para mandar mensajes y esperar respuestas
async function abrirChat(link) {
  const url = new URL(link);
  const code = url.pathname.split('/').find(Boolean) || '';
  const clientId = `prueba-${crypto.randomBytes(6).toString('hex')}`;

  // La página se abre primero (como un cliente real); el script se conecta a la misma conversación
  let pagina = null;
  let contexto = null;
  if (NAVEGADOR) {
    const { browser, contextoBase } = await abrirNavegador();
    contexto = await browser.newContext(contextoBase);
    pagina = await contexto.newPage();
    url.searchParams.set('cliente', clientId);
    url.searchParams.set('nombre', 'Prueba');
    await pagina.goto(url.toString());
    await pagina.locator('#textInput').waitFor({ timeout: 15000 });
  }

  const socket = io(url.origin, { auth: { clientId, name: 'Prueba', code }, transports: ['websocket'] });

  const recibidos = []; // mensajes de Sandra (influencer) en orden
  let ultimoMensajeAt = Date.now();
  let conversationId = null;

  const init = await new Promise((ok, mal) => {
    socket.once('init', ok);
    socket.once('connect_error', (e) => mal(new Error(`No se pudo abrir el chat: ${e.message}`)));
    setTimeout(() => mal(new Error('El chat no respondió (¿link o URL correctos?)')), 15000);
  });
  conversationId = init.messages[0]?.conversation_id ?? null;
  socket.on('message', (m) => {
    conversationId ??= m.conversation_id;
    if (m.sender === 'influencer') {
      recibidos.push(m.type === 'text' ? m.content : `[${m.type}]`);
      ultimoMensajeAt = Date.now();
    }
  });

  // Espera a que Sandra conteste y deje de mandar mensajes; devuelve lo que llegó en este turno
  async function esperarRespuesta(desde) {
    const inicio = Date.now();
    while (Date.now() - inicio < MAX_ESPERA_MS) {
      await espera(250);
      if (recibidos.length > desde && Date.now() - ultimoMensajeAt >= SILENCIO_MS) break;
    }
    return recibidos.slice(desde);
  }

  async function enviar(texto) {
    const desde = recibidos.length;
    if (pagina) {
      // Escribe letra por letra en la página, como una persona
      await pagina.locator('#textInput').pressSequentially(texto, { delay: 35 });
      await pagina.locator('#sendBtn').click();
    } else {
      const ack = await new Promise((ok) => socket.emit('message', { type: 'text', content: texto }, ok));
      if (!ack?.ok) throw new Error(`El chat no aceptó el mensaje: ${ack?.error ?? 'sin respuesta'}`);
    }
    return esperarRespuesta(desde);
  }

  return {
    enviar,
    esperarRespuesta,
    recibidos,
    cerrar: () => socket.close(),
    // Con navegador: la ventana se queda abierta hasta que tú la cierres (con --sin-esperar se cierra sola)
    async cerrarVentana() {
      if (!contexto) return;
      if (ESPERAR_VENTANA) {
        console.log(amarillo('  ⏸  Cierra la ventana del navegador para pasar a la siguiente conversación...'));
        await new Promise((listo) => {
          pagina.once('close', listo);
          contexto.once('close', listo);
          navegador?.browser.once('disconnected', listo);
        });
      } else {
        await espera(4000);
      }
      await contexto.close().catch(() => {});
    },
    get conversationId() { return conversationId; },
  };
}

const imprimir = (quien, texto) => {
  const etiqueta = quien === 'cliente' ? azul('  Cliente:') : negritas('  Sandra: ');
  console.log(`${etiqueta} ${String(texto).replace(/\n/g, '\n           ')}`);
};

async function correrEscenario(nombre, escenario, corrida) {
  console.log(`\n${negritas(`▶ ${nombre}`)}${VECES > 1 ? gris(` (corrida ${corrida}/${VECES})`) : ''} ${gris(escenario.descripcion)}`);
  const chat = await abrirChat(LINK);
  const ctx = { correo: `prueba+${Date.now().toString(36)}@example.com`, ultimoTurno: [] };
  const fallas = [];
  const conversacion = []; // para el reporte
  const revisadas = [];
  let revisiones = 0;
  const anotar = (quien, texto) => { imprimir(quien, texto); conversacion.push({ quien, texto }); };

  try {
    // Saludo (puede tardar unos segundos en llegar)
    const saludo = await chat.esperarRespuesta(0);
    saludo.forEach((m) => anotar('sandra', m));

    const revisar = (texto, que, ok) => {
      revisiones++;
      console.log(`    ${ok ? verde('✔') : rojo('✘')} ${que}`);
      revisadas.push({ que, ok });
      if (!ok) fallas.push(`"${texto}": ${que}`);
    };

    // Escenario con cliente que contesta lo que Sandra pregunta: responder(ctx) da el siguiente
    // mensaje (texto o { cliente, revisar }) o { fin: true, revisar } cuando ya terminó.
    if (escenario.responder) {
      let terminado = false;
      let ultimo = '';
      for (ctx.turno = 0; ctx.turno < MAX_TURNOS; ctx.turno++) {
        let r = escenario.responder(ctx);
        if (typeof r === 'string') r = { cliente: r };
        for (const { que, ok } of r.revisar ?? []) revisar(ultimo, que, ok);
        if (r.fin) { terminado = true; break; }
        ultimo = r.cliente;
        anotar('cliente', ultimo);
        const turno = await chat.enviar(ultimo);
        if (!turno.length) { imprimir('sandra', rojo('(sin respuesta)')); conversacion.push({ quien: 'sandra', texto: '(sin respuesta)' }); }
        turno.forEach((m) => anotar('sandra', m));
        ctx.ultimoTurno = turno;
      }
      if (!terminado) revisar(ultimo, `llega al precio en ${MAX_TURNOS} mensajes o menos`, false);
    }

    for (const paso of escenario.pasos ?? []) {
      if (paso.soloSi && !paso.soloSi(ctx)) {
        console.log(gris('  (paso omitido: no aplica en esta rama del flujo)'));
        continue;
      }
      const texto = typeof paso.cliente === 'function' ? paso.cliente(ctx) : paso.cliente;
      anotar('cliente', texto);
      const turno = await chat.enviar(texto);
      if (!turno.length) { imprimir('sandra', rojo('(sin respuesta)')); conversacion.push({ quien: 'sandra', texto: '(sin respuesta)' }); }
      turno.forEach((m) => anotar('sandra', m));
      ctx.ultimoTurno = turno;

      for (const { que, re } of paso.debe ?? []) {
        revisiones++;
        const ok = turno.some((m) => re.test(m));
        console.log(`    ${ok ? verde('✔') : rojo('✘')} ${que}`);
        revisadas.push({ que, ok });
        if (!ok) fallas.push(`"${texto}": ${que}`);
      }
      for (const { que, re } of paso.noDebe ?? []) {
        revisiones++;
        const ok = !turno.some((m) => re.test(m));
        console.log(`    ${ok ? verde('✔') : rojo('✘')} ${que}`);
        revisadas.push({ que, ok });
        if (!ok) fallas.push(`"${texto}": ${que}`);
      }
    }
  } catch (err) {
    fallas.push(err.message);
    revisadas.push({ que: `Error: ${err.message}`, ok: false });
    console.log(rojo(`  Error: ${err.message}`));
  } finally {
    chat.cerrar();
  }

  const marca = fallas.length ? rojo('✘') : verde('✔');
  console.log(`  ${marca} ${gris(`Conversación #${chat.conversationId ?? '?'} · ${revisiones - fallas.length}/${revisiones} revisiones OK`)}`);
  await chat.cerrarVentana();
  return { nombre, fallas, conversationId: chat.conversationId, conversacion, revisadas, tipo: escenario.tipo, descripcion: escenario.descripcion, corrida };
}

(async () => {
  const objetivo = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  if (!objetivo || objetivo === 'lista') uso();
  if (objetivo === 'tramites') {
    const { conectar, descargarCatalogo, imprimirTramites } = require('./sigev-catalogo');
    const { sigev } = await conectar();
    imprimirTramites((await descargarCatalogo(sigev)).filas);
    process.exit(0);
  }
  if (!LINK) uso('Falta el link del chat: usa --link https://…/CODIGO o pon PRUEBAS_LINK en .env');

  // "precios": un escenario por cada precio de SIGEV (filtrables con --tramite, --estado y --limite)
  let escenarios = ESCENARIOS;
  if (objetivo === 'precios') {
    const { cargarEscenariosPrecios } = require('./escenarios-precios');
    escenarios = await cargarEscenariosPrecios({
      tramite: opcion('tramite'), estado: opcion('estado'), limite: opcion('limite'), directo: args.includes('--directo'),
    });
    console.log(gris(`${Object.keys(escenarios).length} conversaciones de precios (una por combinación de SIGEV)`));
    if (!Object.keys(escenarios).length) uso('No hay precios con esos filtros');
  }
  const nombres = ['todos', 'precios'].includes(objetivo) ? Object.keys(escenarios) : [objetivo];
  for (const n of nombres) if (!escenarios[n]) uso(`No existe el escenario "${n}"`);

  const resultados = [];
  for (let corrida = 1; corrida <= VECES; corrida++) {
    for (const n of nombres) resultados.push(await correrEscenario(n, escenarios[n], corrida));
  }

  // Resumen
  console.log(`\n${negritas('Resumen')}`);
  const porEscenario = {};
  for (const r of resultados) (porEscenario[r.nombre] ??= []).push(r);
  for (const [n, rs] of Object.entries(porEscenario)) {
    const bien = rs.filter((r) => !r.fallas.length).length;
    const marca = bien === rs.length ? verde('✔') : rojo('✘');
    console.log(`  ${marca} ${n.padEnd(20)} ${bien}/${rs.length} corridas sin fallas`);
    for (const r of rs) for (const f of r.fallas) console.log(rojo(`      #${r.conversationId ?? '?'} ${f}`));
  }
  if (navegador) await navegador.browser.close().catch(() => {});

  const reporte = guardarReporte({
    nombre: objetivo === 'precios' ? 'conversaciones-precios' : 'conversaciones',
    titulo: objetivo === 'precios' ? 'Conversaciones de precios con Sandra' : 'Conversaciones de prueba con Sandra',
    subtitulo: `Chat ${new URL(LINK).origin} · ${VECES} corrida(s)${opcion('tramite') ? ` · trámite ${opcion('tramite')}` : ''}${opcion('estado') ? ` · estado ${opcion('estado')}` : ''}`,
    resultados: resultados.map((r) => ({
      tipo: r.tipo ?? r.nombre,
      caso: `${r.nombre}${VECES > 1 ? ` (corrida ${r.corrida})` : ''} · conversación #${r.conversationId ?? '?'}`,
      ok: !r.fallas.length,
      esperado: r.descripcion,
      obtenido: `${r.revisadas.filter((v) => v.ok).length}/${r.revisadas.length} revisiones`,
      detalle: r.fallas.join(' | '),
      revisiones: r.revisadas,
      conversacion: r.conversacion,
    })),
    abrir: !args.includes('--no-abrir'),
  });
  console.log(gris(`\nReporte: ${reporte.html}\nCSV:     ${reporte.csv}`));
  process.exit(resultados.every((r) => !r.fallas.length) ? 0 : 1);
})().catch((err) => {
  console.error(rojo(err.message));
  process.exit(1);
});
