require('dotenv').config({ quiet: true });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const db = require('./db');
const referral = require('./referral');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const API_KEY = process.env.API_KEY || '';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET || '';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
// CRM (leadsgg): ahí se crea el lead cuando el cliente acepta continuar el trámite
const CRM_URL = (process.env.CRM_URL || '').replace(/\/+$/, '');
const CRM_API_TOKEN = process.env.CRM_API_TOKEN || '';
// SIGEV: usuario (que también es socio) con el que el chat genera las cotizaciones de costo fijo
const SIGEV_URL = (process.env.SIGEV_URL || 'https://my.grupogevhe.com').replace(/\/+$/, '');
const SIGEV_EMAIL = process.env.SIGEV_EMAIL || '';
const SIGEV_PASSWORD = process.env.SIGEV_PASSWORD || '';
const APP_ANDROID_URL = process.env.APP_ANDROID_URL || 'https://play.google.com/store/apps/details?id=com.grupogevhe.app&hl=es_MX';
const APP_IOS_URL = process.env.APP_IOS_URL || 'https://apps.apple.com/mx/app/gevhe-app/id6759180407';
// Primer mensaje de la influencer en cada conversación nueva. GREETING_MESSAGE=off lo desactiva.
const GREETING_MESSAGE = ((g) => (g === 'off' ? '' : g))(
  (process.env.GREETING_MESSAGE || '¡Hola! 👋 Qué gusto que me escribas. ¿En qué te puedo ayudar o qué trámite vas a realizar?').trim()
);

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_TEXT = 2000;
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
const IMAGE_URL_RE = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|gif|webp)$/;
const EXTERNAL_URL_RE = /^https?:\/\/\S+$/i;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const LINK_CODE_RE = /^[A-Za-z0-9]{8}$/;
const INVALID_LINK = 'Este link no es válido o ya no está activo';
const MESSAGE_SPLIT_RE = /\s*\[SEPARAR\]\s*/i; // separa una respuesta del bot en varios mensajes
const SPLIT_DELAY_MS = 900;
const EXTERNAL_REF_RE = /^chat-(\d+)$/; // external_reference que pone el CRM en Mercado Pago

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Detrás de un proxy (Nginx, Cloudflare...) pon TRUST_PROXY=1 para usar la IP real del visitante
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- Utilidades ----------
const room = (conversationId) => `conv:${conversationId}`;
const absoluteUrl = (url) => (url.startsWith('/') ? PUBLIC_URL + url : url);
const toApi = (msg) => (msg.type === 'image' ? { ...msg, content: absoluteUrl(msg.content) } : msg);
const publicInfluencer = (i) => ({
  id: i.id,
  slug: i.slug,
  name: i.name,
  avatar: i.avatar,
  verified: i.verified,
  last_seen: i.last_seen,
});

// Valida el contenido de un mensaje. Las imágenes externas (http/https) solo se aceptan desde la API.
function normalizeMessage(type, raw, allowExternalImages) {
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (type === 'text') {
    if (!content) return { error: 'Mensaje vacío' };
    if (content.length > MAX_TEXT) return { error: `Máximo ${MAX_TEXT} caracteres` };
    return { content };
  }
  if (type === 'image') {
    if (IMAGE_URL_RE.test(content)) return { content };
    if (allowExternalImages && EXTERNAL_URL_RE.test(content) && content.length <= 1000) return { content };
    return { error: 'Imagen inválida' };
  }
  return { error: 'Tipo de mensaje inválido (usa "text" o "image")' };
}

// ---------- Límite de links inválidos por IP (evita probar firmas a ciegas) ----------
const BAD_LINK_LIMIT = 20;
const BAD_LINK_WINDOW_MS = 15 * 60 * 1000;
const badLinkAttempts = new Map(); // ip -> { count, resetAt }

function isBlocked(ip) {
  const entry = badLinkAttempts.get(ip);
  return !!entry && entry.resetAt > Date.now() && entry.count >= BAD_LINK_LIMIT;
}

function registerBadLink(ip) {
  const now = Date.now();
  const entry = badLinkAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    badLinkAttempts.set(ip, { count: 1, resetAt: now + BAD_LINK_WINDOW_MS });
  } else {
    entry.count++;
    if (entry.count === BAD_LINK_LIMIT) console.warn(`IP bloqueada 15 min por links inválidos: ${ip}`);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of badLinkAttempts) if (entry.resetAt <= now) badLinkAttempts.delete(ip);
}, 60 * 1000).unref();

function socketIp(socket) {
  if (TRUST_PROXY) {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return socket.handshake.address;
}

// Valida un código de link y que el influencer exista y esté activo.
async function resolveLink(code) {
  const parsed = referral.parseCode(code);
  if (!parsed) return null;
  const influencer = await db.getActiveInfluencer(parsed.influencerId);
  return influencer ? { influencer, source: parsed.source } : null;
}

function linksFor(influencerId) {
  const links = {};
  for (const source of referral.SOURCES) {
    const code = referral.buildCode(influencerId, source);
    links[source] = { code, url: `${PUBLIC_URL}/${code}` };
  }
  return links;
}

// "Escribiendo..." automático: aparece 1 s después de que el cliente envía un mensaje
// y se mantiene hasta que llega la respuesta de la influencer por la API.
const AUTO_TYPING_DELAY_MS = 1000;
const typingTimers = new Map(); // conversationId -> timeout

function scheduleAutoTyping(conversationId) {
  clearTimeout(typingTimers.get(conversationId));
  typingTimers.set(
    conversationId,
    setTimeout(() => {
      typingTimers.delete(conversationId);
      io.to(room(conversationId)).emit('typing', { typing: true });
    }, AUTO_TYPING_DELAY_MS)
  );
}

function cancelAutoTyping(conversationId) {
  clearTimeout(typingTimers.get(conversationId));
  typingTimers.delete(conversationId);
}

// Envía a n8n cada mensaje del cliente (no bloquea el chat si n8n falla)
async function notifyN8n(payload) {
  if (!N8N_WEBHOOK_URL) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (N8N_WEBHOOK_SECRET) headers['x-webhook-secret'] = N8N_WEBHOOK_SECRET;
    const res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`Webhook de n8n respondió ${res.status}`);
  } catch (err) {
    console.error('Error llamando al webhook de n8n:', err.message);
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(503).json({ error: 'API_KEY no está configurada en .env' });
  const given = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(given, API_KEY)) return res.status(401).json({ error: 'API key inválida' });
  next();
}

async function findConversation(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.getConversation(id);
}

// ---------- Subida de fotos (clientes) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new Error('Solo se permiten imágenes JPG, PNG, GIF o WEBP')),
});

app.post('/api/upload', (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'La imagen supera 5 MB' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    res.json({ url: '/uploads/' + req.file.filename });
  });
});

// ---------- API para n8n (respuestas de la influencer) ----------

// Enviar un mensaje de la influencer a una conversación
app.post('/api/messages', requireApiKey, async (req, res) => {
  const body = req.body || {};
  const conversation = await findConversation(body.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

  const type = body.type || 'text';
  // El bot puede mandar varios mensajes en una respuesta separándolos con [SEPARAR]
  const partes = type === 'text' && typeof body.content === 'string'
    ? body.content.split(MESSAGE_SPLIT_RE).map((p) => p.trim()).filter(Boolean).slice(0, 5)
    : [body.content];
  const normalizados = partes.map((p) => normalizeMessage(type, p, true));
  const invalido = normalizados.find((n) => n.error);
  if (invalido || !normalizados.length) return res.status(400).json({ error: invalido?.error || 'Mensaje vacío' });

  cancelAutoTyping(conversation.id); // si la respuesta llega antes de 1 s, no mostrar "Escribiendo..."
  const enviados = [];
  for (const [i, norm] of normalizados.entries()) {
    if (i > 0) {
      // Entre mensajes, un instante de "Escribiendo..." para que se lean como dos mensajes seguidos
      io.to(room(conversation.id)).emit('typing', { typing: true });
      await new Promise((r) => setTimeout(r, SPLIT_DELAY_MS));
    }
    const msg = await db.insertMessage({
      conversationId: conversation.id,
      sender: 'influencer',
      type,
      content: norm.content,
    });
    io.to(room(conversation.id)).emit('message', msg);
    enviados.push(msg);
  }
  const now = new Date();
  await db.touchInfluencer(conversation.influencer_id, now);
  io.to(room(conversation.id)).emit('presence', { lastSeen: now.toISOString() });

  res.status(201).json({ ok: true, message: toApi(enviados[0]), messages: enviados.map(toApi) });
});

// Mostrar / ocultar "Escribiendo..." de la influencer
app.post('/api/typing', requireApiKey, async (req, res) => {
  const body = req.body || {};
  const conversation = await findConversation(body.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

  cancelAutoTyping(conversation.id);
  io.to(room(conversation.id)).emit('typing', { typing: body.typing !== false });
  res.json({ ok: true });
});

// Historial de una conversación (para dar contexto en n8n)
app.get('/api/conversations/:conversationId/messages', requireApiKey, async (req, res) => {
  const conversation = await findConversation(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const [client, influencer, messages] = await Promise.all([
    db.getClient(conversation.client_id),
    db.getInfluencer(conversation.influencer_id),
    db.getMessages(conversation.id, limit),
  ]);
  res.json({
    conversationId: conversation.id,
    referralStatus: conversation.referral_status,
    client,
    influencer: publicInfluencer(influencer),
    messages: messages.map(toApi),
  });
});

// Registrar al cliente cuando acepta continuar el trámite: guarda su nombre, le da un código
// para la app y crea el lead en el CRM (tablero Comercial, primera columna) con el influencer de origen.
app.post('/api/conversations/:conversationId/registro', requireApiKey, async (req, res) => {
  const conversation = await findConversation(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

  const nombre = String(req.body?.nombre ?? '').replace(/\s+/g, ' ').trim();
  if (nombre.length < 2 || nombre.length > 100) {
    return res.status(400).json({ error: 'nombre es obligatorio (2 a 100 caracteres)' });
  }

  const result = await db.registerLead(conversation.id, nombre);
  if (!result) return res.status(404).json({ error: 'Conversación no encontrada' });
  const conv = result.conversation;

  let crm = { sincronizado: Boolean(conv.crm_lead_id), leadId: conv.crm_lead_id ?? null };
  if (!conv.crm_lead_id && CRM_URL && CRM_API_TOKEN) {
    crm = await crearLeadEnCrm(conv, nombre);
    if (crm.leadId) await db.setCrmLeadId(conv.id, crm.leadId);
  }

  res.status(result.created ? 201 : 200).json({
    ok: true,
    codigo: conv.app_code,
    nuevo: result.created,
    app: { android: APP_ANDROID_URL, iphone: APP_IOS_URL },
    crm,
  });
});

// Precotización aceptada: n8n la guarda cuando el cliente dice que sí quiere continuar
// y recibe el código de seguimiento (PRE0000001) que Sandra le da junto con los links de la app.
app.post('/api/conversations/:conversationId/precotizaciones', requireApiKey, async (req, res) => {
  const conversation = await findConversation(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

  const body = req.body || {};
  const datos = leerDatosCotizacion(body);
  if (datos.error) return res.status(400).json({ error: datos.error });

  const { precotizacion, created } = await db.createPrecotizacion(conversation, datos);

  // Con enviar_mensaje, el servidor manda al chat el código y los links de la app (solo la primera vez):
  // así el código nunca lo escribe el bot y siempre llega antes que el precio.
  let mensajeEnviado = false;
  if (created && (body.enviar_mensaje === true || body.enviar_mensaje === 'true')) {
    await sendInfluencerMessage(conversation, mensajeCodigoApp(precotizacion.codigo));
    mensajeEnviado = true;
  }

  res.status(created ? 201 : 200).json({
    ok: true,
    codigo: precotizacion.codigo,
    nueva: created,
    mensaje_enviado: mensajeEnviado,
    precotizacion,
    app: { android: APP_ANDROID_URL, iphone: APP_IOS_URL },
  });
});

// Datos de un precio (los manda n8n). Devuelve { error } o los datos listos para guardar.
function leerDatosCotizacion(body) {
  const texto = (v, max) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
  };
  const tramite = texto(body.tramite, 120);
  if (!tramite) return { error: 'tramite es obligatorio' };

  let costo = null;
  if (body.costo !== undefined && body.costo !== null && body.costo !== '') {
    costo = Number(String(body.costo).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(costo) || costo < 0) return { error: 'costo no es un número válido' };
  }
  const idTramite = Number(body.id_tramite);

  // Valores "id-ALIAS" que pide SIGEV para crear la cotización (18-LICEN, 2-MOTO, 15-EDOMEX, 3-CL, 70-2018)
  const sigev = {};
  for (const campo of ['tipo_tramite', 'tipo_vehiculo', 'entidad', 'tipo_servicio', 'modelo']) {
    const v = texto(body.sigev?.[campo], 60);
    if (v && /^\d+-.+/.test(v)) sigev[campo] = v;
  }

  return {
    tramite,
    estado: texto(body.estado, 60),
    vehiculo: texto(body.vehiculo, 60),
    servicio: texto(body.servicio, 20),
    costo,
    masImpuestos: body.mas_impuestos === true || body.mas_impuestos === 'true' || body.mas_impuestos === 1,
    // Nombre oficial del trámite en SIGEV (lo manda n8n): "Licencia de manejo", "Cambio de propietario"
    idTramite: Number.isInteger(idTramite) && idTramite > 0 ? idTramite : null,
    nombreTramite: texto(body.nombre_tramite, 150),
    sigev,
  };
}

// [copiar]…[/copiar] y [texto](url) los dibuja el chat como botón de copiar y como link
const LINKS_APP = `Android: [Descargar](${APP_ANDROID_URL})\niPhone: [Descargar](${APP_IOS_URL})`;
const mensajeCodigoApp = (codigo) =>
  `El código de tu precotización es [copiar]${codigo}[/copiar] puedes usarlo en la app para darle seguimiento a tu precotización. ` +
  `Puedes descargar la app desde los siguientes links:\n${LINKS_APP}`;
const MENSAJE_ASESOR = 'Un asesor se contactará contigo por medio de nuestra app 🙌';
const mensajeCodigoTramite = (clave, correo) =>
  `El código de tu trámite es [copiar]${clave}[/copiar] guárdalo bien, será tu contraseña 🔐\n` +
  `Para continuar descarga la app desde los siguientes links:\n${LINKS_APP}\n` +
  'En la pantalla de login ingresa tu correo (el que me diste) y en contraseña el código de tu trámite. Ejemplo:\n' +
  `Correo electrónico: ${correo}\nContraseña: ${clave}`;

// Mensaje de la influencer generado por el servidor (no por n8n)
async function sendInfluencerMessage(conversation, content) {
  const msg = await db.insertMessage({ conversationId: conversation.id, sender: 'influencer', type: 'text', content });
  const now = new Date();
  await db.touchInfluencer(conversation.influencer_id, now);
  io.to(room(conversation.id)).emit('message', msg);
  io.to(room(conversation.id)).emit('presence', { lastSeen: now.toISOString() });
  // Sandra sigue "escribiendo" el precio que n8n manda enseguida
  io.to(room(conversation.id)).emit('typing', { typing: true });
  return msg;
}

// ---------- Flujo de cotización del chat ----------
// 1) n8n (cotizar_tramite) da el precio y lo registra aquí → POST .../cotizacion
// 2) El cliente responde si quiere avanzar          → POST .../respuesta-cotizacion { acepta }
//    No: su lead regresa a la primera columna de Comercial.
//    Sí, sin costo fijo (más impuestos): precotización PRE + "un asesor te contactará".
//    Sí, con costo fijo: Sandra pide nombre y correo.
// 3) Con nombre y correo                            → POST .../generar-cotizacion { nombre, correo }
//    Se crea la cotización en SIGEV (COTA…) y el cliente recibe su código para entrar a la app.

const ahora = () => new Date().toISOString();

// Último precio que se le dio al cliente. Todavía NO es precotización (no va a ent_precotizaciones).
app.post('/api/conversations/:conversationId/cotizacion', requireApiKey, async (req, res) => {
  const conversation = await findConversation(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });
  const datos = leerDatosCotizacion(req.body || {});
  if (datos.error) return res.status(400).json({ error: datos.error });
  // Costo fijo = SIGEV no le suma impuestos (mas_impuestos = 0)
  const cotizacion = { ...datos, costoFijo: !datos.masImpuestos, aceptada: null, cotizadaAt: ahora() };
  await db.setUltimaCotizacion(conversation.id, cotizacion);
  res.json({ ok: true, costo_fijo: cotizacion.costoFijo, cotizacion });
});

app.post('/api/conversations/:conversationId/respuesta-cotizacion', requireApiKey, async (req, res) => {
  const conversation = await findConversation(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

  const valor = String(req.body?.acepta ?? '').trim().toLowerCase();
  let acepta = null;
  if (['true', 'si', 'sí', '1'].includes(valor)) acepta = true;
  else if (['false', 'no', '0'].includes(valor)) acepta = false;
  if (acepta === null) return res.status(400).json({ error: 'acepta debe ser true o false' });

  const cotizacion = db.getUltimaCotizacion(conversation);
  if (!cotizacion) {
    return res.status(409).json({
      ok: false,
      mensaje: 'Todavía no le has dado un precio a este cliente. Pregúntale qué trámite necesita y usa cotizar_tramite.',
    });
  }

  await db.setUltimaCotizacion(conversation.id, { ...cotizacion, aceptada: acepta, respondidaAt: ahora() });

  if (!acepta) {
    const crm = await actualizarLeadEnCrm(conversation, { primera_columna: true });
    return res.json({
      ok: true,
      acepta,
      crm,
      mensaje: 'El cliente no quiere avanzar. Respóndele breve y amable que aquí estás si cambia de opinión o necesita otro trámite. No insistas ni repitas el precio.',
    });
  }

  if (cotizacion.costoFijo) {
    return res.json({
      ok: true,
      acepta,
      costo_fijo: true,
      mensaje: 'El cliente quiere avanzar y el trámite tiene costo fijo. Pídele en un solo mensaje su nombre completo y su correo electrónico (con ese correo entrará a la app). Cuando te los dé, llama a generar_cotizacion con nombre y correo. No le des ningún código todavía.',
    });
  }

  const { codigo, nueva } = await enviarPrecotizacion(conversation, cotizacion);
  res.json({
    ok: true,
    acepta,
    costo_fijo: false,
    codigo,
    nueva,
    mensaje: nueva
      ? `El cliente YA recibió en mensajes aparte que un asesor lo contactará por la app y su código de precotización (${codigo}) con los links de la app. NO repitas el código, los links ni el precio. Responde solo una frase corta de cierre, por ejemplo: "¿Te puedo ayudar con algo más? 😊".`
      : `El cliente ya tenía su código de precotización (${codigo}) y los links de la app. NO los repitas: responde solo a lo último que dijo.`,
  });
});

app.post('/api/conversations/:conversationId/generar-cotizacion', requireApiKey, async (req, res) => {
  const conversation = await findConversation(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

  const nombre = String(req.body?.nombre ?? '').replace(/\s+/g, ' ').trim();
  const correo = String(req.body?.correo ?? '').trim().toLowerCase();
  if (nombre.length < 2 || nombre.length > 100) {
    return res.status(400).json({ ok: false, mensaje: 'Falta el nombre completo del cliente: pídeselo.' });
  }
  if (correo.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
    return res.status(400).json({ ok: false, mensaje: `El correo "${correo}" no es válido: pídeselo de nuevo al cliente.` });
  }

  const cotizacion = db.getUltimaCotizacion(conversation);
  if (!cotizacion || cotizacion.aceptada !== true || !cotizacion.costoFijo) {
    return res.status(409).json({
      ok: false,
      mensaje: 'Solo se genera cuando el cliente aceptó un precio de costo fijo. Usa primero cotizar_tramite y respuesta_cotizacion.',
    });
  }
  if (cotizacion.claveCotizacion) {
    return res.json({
      ok: true,
      clave: cotizacion.claveCotizacion,
      nueva: false,
      mensaje: `El cliente ya tiene su código (${cotizacion.claveCotizacion}) y las instrucciones de la app. NO los repitas: responde solo a lo último que dijo.`,
    });
  }

  await db.setLeadDatos(conversation.id, nombre, correo);
  const crm = await actualizarLeadEnCrm({ ...conversation, lead_name: nombre }, { nombre, correo });

  let clave = null;
  let errorSigev = null;
  try {
    clave = await crearCotizacionSigev(cotizacion, nombre, correo);
  } catch (err) {
    errorSigev = err.message;
    console.error(`SIGEV: no se generó la cotización de la conversación ${conversation.id}: ${err.message}`);
  }

  if (!clave) {
    // Sin SIGEV no hay código para la app: sigue como precotización y lo atiende un asesor
    const { codigo } = await enviarPrecotizacion(conversation, cotizacion);
    return res.json({
      ok: true,
      sigev: false,
      error_sigev: errorSigev,
      codigo,
      crm,
      mensaje: `No se pudo generar el trámite; el cliente YA recibió que un asesor lo contactará por la app y su código de precotización (${codigo}). NO repitas el código ni los links. Responde solo una frase corta de cierre.`,
    });
  }

  await db.setUltimaCotizacion(conversation.id, { ...cotizacion, claveCotizacion: clave, nombre, correo, generadaAt: ahora() });
  const { precotizacion } = await db.createPrecotizacion(conversation, { ...cotizacion, claveCotizacion: clave });
  await sendInfluencerMessage(conversation, mensajeCodigoTramite(clave, correo));

  res.json({
    ok: true,
    sigev: true,
    clave,
    codigo: precotizacion.codigo,
    crm,
    mensaje: `El cliente YA recibió en un mensaje aparte el código de su trámite (${clave}), los links de la app y cómo iniciar sesión. NO repitas el código, los links ni las instrucciones. Responde solo una frase corta de cierre, por ejemplo: "¡Listo! Cualquier duda aquí estoy 😊".`,
  });
});

// Guarda la precotización (PRE…) y manda "un asesor te contactará" + el código con los links de la app
async function enviarPrecotizacion(conversation, cotizacion) {
  const { precotizacion, created } = await db.createPrecotizacion(conversation, cotizacion);
  if (created) {
    await sendInfluencerMessage(conversation, MENSAJE_ASESOR);
    await new Promise((r) => setTimeout(r, SPLIT_DELAY_MS));
    await sendInfluencerMessage(conversation, mensajeCodigoApp(precotizacion.codigo));
  }
  return { codigo: precotizacion.codigo, nueva: created };
}

// ---------- SIGEV ----------
async function sigevPost(ruta, body, token) {
  const resp = await fetch(`${SIGEV_URL}${ruta}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.success === false || data.status === 'error') {
    const detalle = data.error || data.message || (data.errors && JSON.stringify(data.errors)) || 'sin detalle';
    throw new Error(`${ruta} → HTTP ${resp.status}: ${detalle}`);
  }
  return data;
}

// "Juan Carlos Pérez López" → nombre "Juan Carlos", apellidos "Pérez López"
function separarNombre(completo) {
  const partes = completo.split(' ');
  if (partes.length === 1) return { nombre: completo, apellidos: '' };
  const nApellidos = partes.length >= 3 ? 2 : 1;
  return { nombre: partes.slice(0, -nApellidos).join(' '), apellidos: partes.slice(-nApellidos).join(' ') };
}

// Crea la cotización en SIGEV a nombre del cliente y devuelve su clave (COTA…).
// El cliente entra a la app con su correo y esa clave; el trámite A se genera en la app al pagar el anticipo.
async function crearCotizacionSigev(cotizacion, nombreCompleto, correo) {
  if (!SIGEV_EMAIL || !SIGEV_PASSWORD) throw new Error('SIGEV_EMAIL o SIGEV_PASSWORD sin configurar');
  const s = cotizacion.sigev || {};
  const faltan = ['tipo_tramite', 'tipo_vehiculo', 'entidad', 'tipo_servicio'].filter((c) => !s[c]);
  if (faltan.length) throw new Error(`faltan datos para SIGEV (${faltan.join(', ')}): actualiza el código de n8n`);

  const { token } = await sigevPost('/api/login', { email: SIGEV_EMAIL, password: SIGEV_PASSWORD });
  if (!token) throw new Error('SIGEV no devolvió token');

  const creada = await sigevPost(
    '/api/cotizacion/createCotizacionExpres',
    { ...s, email: correo, subtotal: cotizacion.costo ?? 0, descuento: 0 },
    token
  );
  if (!creada.clave) throw new Error('SIGEV no devolvió la clave de la cotización');

  // La cotización exprés se crea a nombre de "DATOS PENDIENTES": se le pone el nombre real del cliente
  const { nombre, apellidos } = separarNombre(nombreCompleto);
  try {
    await sigevPost(
      '/api/cotizacion/actualizar',
      { datos_completos: 0, clave: creada.clave, nombre, apellidos, email: correo },
      token
    );
  } catch (err) {
    console.error(`SIGEV: la cotización ${creada.clave} se creó, pero no se le pudo poner el nombre: ${err.message}`);
  }
  return creada.clave;
}

app.get('/api/conversations/:conversationId/precotizaciones', requireApiKey, async (req, res) => {
  const conversation = await findConversation(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });
  res.json({ conversationId: conversation.id, precotizaciones: await db.getPrecotizaciones(conversation.id) });
});

// Todas las precotizaciones: ?influencer=<id|slug>&desde=YYYY-MM-DD&hasta=YYYY-MM-DD&limit=50&offset=0
app.get('/api/precotizaciones', requireApiKey, async (req, res) => {
  const fecha = (v) => (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(String(v ?? '')) ? String(v) : null);
  for (const campo of ['desde', 'hasta']) {
    if (req.query[campo] && !fecha(req.query[campo])) {
      return res.status(400).json({ error: `${campo} debe tener formato YYYY-MM-DD` });
    }
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const resultado = await db.listPrecotizaciones({
    influencer: req.query.influencer ? String(req.query.influencer) : null,
    desde: fecha(req.query.desde),
    hasta: fecha(req.query.hasta),
    limit,
    offset,
  });
  res.json({ ...resultado, limit, offset });
});

// SIGEV/la app avisan que el cliente ya ingresó el trámite: liga PRE0000001 con la clave A0064466
// Body: { clave_tramite: 'A0064466' }
app.put('/api/precotizaciones/:codigo/tramite', requireApiKey, async (req, res) => {
  const codigo = String(req.params.codigo).trim().toUpperCase();
  const clave = String(req.body?.clave_tramite ?? '').trim().toUpperCase();
  if (!/^A[0-9A-Z]{1,19}$/.test(clave)) {
    return res.status(400).json({ error: 'clave_tramite es obligatoria y debe empezar con A (ej. A0064466)' });
  }
  const r = await db.setClaveTramite(codigo, clave);
  if (r.error === 'no_existe') return res.status(404).json({ error: `No existe la precotización ${codigo}` });
  if (r.error === 'clave_usada') return res.status(409).json({ error: `La clave ${clave} ya está ligada a otra precotización` });
  res.json({ ok: true, precotizacion: r.precotizacion });
});

// Una precotización por su código (PRE0000001)
app.get('/api/precotizaciones/:codigo', requireApiKey, async (req, res) => {
  const codigo = String(req.params.codigo).trim().toUpperCase();
  const precotizacion = await db.getPrecotizacionByCodigo(codigo);
  if (!precotizacion) return res.status(404).json({ error: `No existe la precotización ${codigo}` });
  res.json({ precotizacion });
});

// Primer mensaje del cliente: se crea su lead en el CRM (tablero Comercial, columna Web).
// Solo una vez por conversación; si el CRM falla, se reintenta con el siguiente mensaje.
const leadsEnCurso = new Set();
async function crearLeadWeb(conversationId, nombreCliente) {
  if (!CRM_URL || !CRM_API_TOKEN || leadsEnCurso.has(conversationId)) return;
  leadsEnCurso.add(conversationId);
  try {
    const conv = await db.getConversation(conversationId);
    if (!conv || conv.crm_lead_id) return;
    const nombre = conv.lead_name || (nombreCliente && nombreCliente !== 'Cliente' ? nombreCliente : null);
    const crm = await crearLeadEnCrm(conv, nombre);
    if (crm.leadId) await db.setCrmLeadId(conv.id, crm.leadId);
  } catch (err) {
    console.error(`CRM: error creando el lead de la conversación ${conversationId}:`, err.message);
  } finally {
    leadsEnCurso.delete(conversationId);
  }
}

// Cambia el lead de la conversación en el CRM: { primera_columna: true } lo regresa a la primera
// columna del tablero Comercial; { nombre, correo } actualizan sus datos. Si aún no existe, lo crea antes.
async function actualizarLeadEnCrm(conv, cambios) {
  if (!CRM_URL || !CRM_API_TOKEN) return { sincronizado: false, motivo: 'CRM_URL o CRM_API_TOKEN sin configurar' };
  try {
    if (!conv.crm_lead_id) {
      const creado = await crearLeadEnCrm(conv, conv.lead_name || null);
      if (!creado.leadId) return { sincronizado: false, motivo: 'no se pudo crear el lead' };
      await db.setCrmLeadId(conv.id, creado.leadId);
    }
    const resp = await fetch(`${CRM_URL}/api/lead/influencer/actualizar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CRM_API_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversacion_id: conv.id, ...cambios }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      console.error(`CRM: no se actualizó el lead de la conversación ${conv.id} (${resp.status}): ${data.message ?? 'sin detalle'}`);
      return { sincronizado: false, motivo: data.message ?? `HTTP ${resp.status}` };
    }
    return { sincronizado: true, leadId: data.lead_id, columna: data.columna ?? null };
  } catch (err) {
    console.error(`CRM: no se pudo conectar para la conversación ${conv.id}: ${err.message}`);
    return { sincronizado: false, motivo: err.message };
  }
}

// Crea (o recupera, si ya existía) el lead de la conversación en el CRM
async function crearLeadEnCrm(conv, nombre) {
  const influencer = await db.getInfluencer(conv.influencer_id);
  try {
    const resp = await fetch(`${CRM_URL}/api/lead/influencer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CRM_API_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversacion_id: conv.id,
        nombre,
        codigo_app: conv.app_code ?? null,
        influencer_id: conv.influencer_id,
        influencer_nombre: influencer?.name ?? null,
        origen: conv.referral_valid ? conv.source : null,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.lead_id) {
      console.error(`CRM: no se creó el lead de la conversación ${conv.id} (${resp.status}): ${data.message ?? 'sin detalle'}`);
      return { sincronizado: false, leadId: null };
    }
    return { sincronizado: true, leadId: data.lead_id };
  } catch (err) {
    console.error(`CRM: no se pudo conectar para la conversación ${conv.id}: ${err.message}`);
    return { sincronizado: false, leadId: null };
  }
}

// ---------- Links de referido (para el CRM) ----------

// Links de todos los influencers
app.get('/api/referral-links', requireApiKey, async (_req, res) => {
  const influencers = await db.getInfluencers();
  res.json(
    influencers.map((i) => ({ influencerId: i.id, name: i.name, active: i.active, links: linksFor(i.id) }))
  );
});

// Links de un influencer
app.get('/api/influencers/:id/referral-links', requireApiKey, async (req, res) => {
  const id = Number(req.params.id);
  const influencer = Number.isInteger(id) && id > 0 ? await db.getInfluencer(id) : null;
  if (!influencer) return res.status(404).json({ error: 'Influencer no encontrado' });
  res.json({ influencerId: influencer.id, name: influencer.name, active: influencer.active, links: linksFor(influencer.id) });
});

// ---------- Webhook de Mercado Pago ----------
// Valida la firma x-signature (si MP_WEBHOOK_SECRET está configurado)
function verifyMercadoPagoSignature(req, dataId) {
  if (!MP_WEBHOOK_SECRET) return true;
  const parts = {};
  for (const piece of (req.get('x-signature') || '').split(',')) {
    const [k, v] = piece.split('=').map((s) => s && s.trim());
    if (k && v) parts[k] = v;
  }
  if (!parts.ts || !parts.v1) return false;

  const requestId = req.get('x-request-id');
  let manifest = `id:${dataId.toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${parts.ts};`;

  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeEqual(expected, parts.v1);
}

app.post('/api/webhooks/mercadopago', async (req, res) => {
  const body = req.body || {};
  const type = req.query.type || req.query.topic || body.type || body.topic;
  const dataId = String(req.query['data.id'] || req.query.id || (body.data && body.data.id) || '');

  // Solo interesan los pagos; el resto se confirma para que MP no reintente
  if (type !== 'payment' || !dataId) return res.sendStatus(200);
  if (!/^\d+$/.test(dataId)) return res.sendStatus(400);
  if (!verifyMercadoPagoSignature(req, dataId)) return res.sendStatus(401);
  if (!MP_ACCESS_TOKEN) {
    console.error('Webhook de Mercado Pago recibido pero MP_ACCESS_TOKEN no está configurado');
    return res.sendStatus(500); // MP reintentará
  }

  // No se confía en el aviso: se consulta el pago real en Mercado Pago
  let payment;
  try {
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return res.sendStatus(200); // p. ej. notificación de prueba
    if (!r.ok) {
      console.error(`Mercado Pago respondió ${r.status} al consultar el pago ${dataId}`);
      return res.sendStatus(502);
    }
    payment = await r.json();
  } catch (err) {
    console.error('Error consultando el pago en Mercado Pago:', err.message);
    return res.sendStatus(502);
  }

  const ref = typeof payment.external_reference === 'string' ? payment.external_reference : '';
  const match = EXTERNAL_REF_RE.exec(ref);

  const result = await db.recordPayment({
    mpPaymentId: String(payment.id),
    conversationId: match ? Number(match[1]) : null,
    externalReference: ref || null,
    status: payment.status || 'unknown',
    statusDetail: payment.status_detail || null,
    amount: payment.transaction_amount ?? null,
    currency: payment.currency_id || null,
    approvedAt: payment.date_approved ? new Date(payment.date_approved) : null,
  });

  if (result.markedPaid) {
    console.log(`Referido pagado: conversación ${result.conversationId} (pago MP ${payment.id})`);
  }
  res.sendStatus(200);
});

// ---------- Página del chat: /{código de 8 caracteres} ----------
app.get('/:code', async (req, res, next) => {
  if (!LINK_CODE_RE.test(req.params.code)) return next();
  if (isBlocked(req.ip)) return res.status(429).type('text').send('Demasiados intentos. Prueba más tarde.');
  if (!(await resolveLink(req.params.code))) {
    registerBadLink(req.ip);
    return res.status(404).type('text').send(INVALID_LINK);
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/', (_req, res) => {
  res.status(404).type('text').send('Abre el chat con el link de un influencer');
});

// Errores en JSON
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ---------- Tiempo real (clientes) ----------
io.use(async (socket, next) => {
  const { clientId, name, code } = socket.handshake.auth || {};
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) {
    return next(new Error('Identificador de cliente inválido'));
  }
  const ip = socketIp(socket);
  if (isBlocked(ip)) return next(new Error('Demasiados intentos. Prueba más tarde.'));

  try {
    const link = await resolveLink(code);
    if (!link) {
      registerBadLink(ip);
      return next(new Error(INVALID_LINK));
    }
    const { influencer, source } = link;

    // Si se detecta que el link se abrió desde otra app, la conversación se abre pero no cuenta
    const userAgent = String(socket.handshake.headers['user-agent'] || '').slice(0, 500);
    const detectedPlatform = referral.detectPlatform(userAgent);
    const valid = !detectedPlatform || detectedPlatform === source;

    const cleanName = typeof name === 'string' ? name.trim().slice(0, 64) : '';
    const client = await db.ensureClient(clientId, cleanName);
    const { conversation, created } = await db.ensureConversation(influencer.id, client.id, {
      source,
      detectedPlatform,
      valid,
      userAgent,
    });
    if (created) {
      await db.insertMessage({ conversationId: conversation.id, sender: 'system', type: 'system', content: 'accepted' });
      // La influencer saluda primero, sin esperar a que el cliente escriba
      if (GREETING_MESSAGE) {
        await db.insertMessage({ conversationId: conversation.id, sender: 'influencer', type: 'text', content: GREETING_MESSAGE });
      }
    }

    socket.data.client = client;
    socket.data.influencer = influencer;
    socket.data.conversation = conversation;
    next();
  } catch (err) {
    console.error('Error abriendo conversación:', err);
    next(new Error('Error del servidor'));
  }
});

io.on('connection', async (socket) => {
  const { client, influencer, conversation } = socket.data;
  socket.join(room(conversation.id));

  try {
    const messages = await db.getMessages(conversation.id);
    socket.emit('init', {
      me: client,
      contact: { ...publicInfluencer(influencer), online: false },
      messages,
    });
  } catch (err) {
    console.error('Error cargando conversación:', err);
    socket.emit('fatal', 'No se pudo cargar la conversación');
  }

  socket.on('message', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const type = payload && payload.type;
      const norm = normalizeMessage(type, payload && payload.content, false);
      if (norm.error) return reply({ ok: false, error: norm.error });

      const msg = await db.insertMessage({
        conversationId: conversation.id,
        sender: 'client',
        type,
        content: norm.content,
      });
      io.to(room(conversation.id)).emit('message', msg);
      reply({ ok: true, id: msg.id });

      scheduleAutoTyping(conversation.id);
      void crearLeadWeb(conversation.id, client.name);
      void notifyN8n({
        event: 'message.received',
        conversationId: conversation.id,
        source: conversation.source,
        client: { id: client.id, name: client.name },
        influencer: { id: influencer.id, slug: influencer.slug, name: influencer.name },
        message: toApi(msg),
        replyUrl: `${PUBLIC_URL}/api/messages`,
      });
    } catch (err) {
      console.error('Error guardando mensaje:', err);
      reply({ ok: false, error: 'No se pudo enviar el mensaje' });
    }
  });

  socket.on('disconnect', async () => {
    try {
      await db.touchClient(client.id, new Date());
    } catch (err) {
      console.error('Error actualizando last_seen:', err);
    }
  });
});

// Comprueba que REF_LINK_SECRET está configurado antes de arrancar
try {
  referral.buildCode(1, 'instagram');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

db.init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chat listo en ${PUBLIC_URL}`);
      console.log(`  Ejemplo (influencer 1, Instagram): ${PUBLIC_URL}/${referral.buildCode(1, 'instagram')}`);
      if (!API_KEY) console.warn('Aviso: API_KEY vacía en .env; la API para n8n está desactivada.');
      if (!N8N_WEBHOOK_URL) console.warn('Aviso: N8N_WEBHOOK_URL vacía en .env; no se avisará a n8n.');
      if (!MP_ACCESS_TOKEN) console.warn('Aviso: MP_ACCESS_TOKEN vacío en .env; no se procesarán pagos.');
      if (MP_ACCESS_TOKEN && !MP_WEBHOOK_SECRET) {
        console.warn('Aviso: MP_WEBHOOK_SECRET vacío; no se valida la firma de Mercado Pago.');
      }
    });
  })
  .catch((err) => {
    console.error('No se pudo iniciar la base de datos. Revisa .env y que MySQL esté encendido.');
    // Los errores de conexión de mysql2 a veces llegan sin mensaje, solo con código (p. ej. ECONNREFUSED)
    const causa = err.errors?.[0] ?? err;
    console.error(`${causa.code ?? 'ERROR'}: ${causa.message || err.message || 'sin detalle'}`);
    console.error(`Conectando a ${db.config.host}:${db.config.port} como ${db.config.user}, base "${db.config.database}"`);
    process.exit(1);
  });
