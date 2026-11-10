// Links de referido: {PUBLIC_URL}/{RED}{INFLUENCER}{FIRMA}   p. ej. /IG07x4Kp
//   RED        2 letras: IG = Instagram, FB = Facebook, TT = TikTok
//   INFLUENCER 2 caracteres base62 derivados del id del influencer (máx. 3843)
//   FIRMA      4 caracteres base62 de un HMAC-SHA256 con REF_LINK_SECRET (14.776.336 combinaciones)
// Sin conocer el secreto no se puede cambiar la red ni el influencer y que el link siga siendo válido.
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_2 = ALPHABET.length ** 2; // 3844
const SIG_LEN = 4;
const MAX_SIG = ALPHABET.length ** SIG_LEN; // 14.776.336

const NETWORKS = { IG: 'instagram', FB: 'facebook', TT: 'tiktok' };
const NETWORK_CODES = Object.fromEntries(Object.entries(NETWORKS).map(([k, v]) => [v, k]));
const SOURCES = Object.values(NETWORKS);

const CODE_RE = /^(IG|FB|TT)([0-9A-Za-z]{2})([0-9A-Za-z]{4})$/;

function secret() {
  const s = process.env.REF_LINK_SECRET || '';
  if (s.length < 16) throw new Error('REF_LINK_SECRET no está configurado en .env (mínimo 16 caracteres)');
  return s;
}

function encode2(n) {
  return ALPHABET[Math.floor(n / ALPHABET.length)] + ALPHABET[n % ALPHABET.length];
}

function decode2(s) {
  return ALPHABET.indexOf(s[0]) * ALPHABET.length + ALPHABET.indexOf(s[1]);
}

function encodeN(n, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out = ALPHABET[n % ALPHABET.length] + out;
    n = Math.floor(n / ALPHABET.length);
  }
  return out;
}

function sign(payload) {
  const digest = crypto.createHmac('sha256', secret()).update(payload).digest();
  return encodeN(digest.readUInt32BE(0) % MAX_SIG, SIG_LEN);
}

// Genera el código para un influencer y una red ('instagram' | 'facebook' | 'tiktok')
function buildCode(influencerId, source) {
  const net = NETWORK_CODES[source];
  if (!net) throw new Error(`Red social inválida: ${source}`);
  if (!Number.isInteger(influencerId) || influencerId < 0 || influencerId >= MAX_2) {
    throw new Error(`El id de influencer ${influencerId} no cabe en 2 caracteres (máx. ${MAX_2 - 1})`);
  }
  const payload = net + encode2(influencerId);
  return payload + sign(payload);
}

// Valida un código. Devuelve { influencerId, source } o null si es inválido o fue alterado.
function parseCode(code) {
  const m = CODE_RE.exec(typeof code === 'string' ? code : '');
  if (!m) return null;
  const [, net, inf, sig] = m;
  const expected = sign(net + inf);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { influencerId: decode2(inf), source: NETWORKS[net] };
}

// Detecta la app desde la que se abrió el link (navegador interno). null = navegador normal / desconocido.
function detectPlatform(userAgent) {
  const ua = userAgent || '';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A|FBSV|Messenger/i.test(ua)) return 'facebook';
  if (/musical_ly|Bytedance|TikTok|trill_/i.test(ua)) return 'tiktok';
  return null;
}

module.exports = { buildCode, parseCode, detectPlatform, SOURCES, CODE_RE };
