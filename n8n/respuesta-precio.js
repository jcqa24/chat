// Código del nodo "Respuesta para el agente" del sub-workflow cotizar_tramite (n8n).
// Recibe la respuesta completa de SIGEV /api/getCosto (Full Response) y la deja lista para el agente.
// Si no hay precio con el servicio pedido, consulta los otros servicios (VIP, XP, CL) para ofrecérselos al cliente.

// Qué incluye cada servicio (descripciones de cat_tiposervicio en SIGEV).
const SERVICIOS = {
  1: { clave: 'VIP', descripcion: 'No pones un pie en la Delegación: GEVHE hace todo por ti.' },
  2: { clave: 'XP', descripcion: 'Servicio XP (pendiente de descripción).' }, // ← pon aquí qué incluye XP
  3: { clave: 'CL', descripcion: 'Para concluir el trámite tienes que acudir tú a la Delegación.' },
};
const DIFERENCIAS = Object.values(SERVICIOS).map((s) => `${s.clave}: ${s.descripcion}`).join(' | ');

// Servidor del chat: cuando hay un precio definido se guarda la precotización y el servidor le manda al
// cliente su código de seguimiento (PRE0000001) y los links de la app ANTES de que Sandra dé el precio.
const CHAT_URL = 'https://vigilant-quietude-production-75938095.up.railway.app'; // ← sin "/" al final
const CHAT_API_KEY = 'PEGA_AQUI_EL_API_KEY_DEL_CHAT'; // ← el mismo x-api-key que usa el nodo que responde

// Lo que Sandra debe decir siempre que da un precio.
const PRECOTIZACION = ' IMPORTANTE: aclara que es una precotización y que el costo final puede variar. Termina preguntándole si quiere continuar con el trámite.';
const conCodigo = (codigo) => codigo
  ? ` IMPORTANTE: el cliente YA recibió en un mensaje aparte su código de seguimiento (${codigo}) y los links de la app. No los repitas ni escribas ningún código. Da solo el precio, aclarando que es una precotización y que el costo final puede variar.`
  : PRECOTIZACION;

const respuesta = $input.first().json;
const { resumen, body, sigevUrl } = $('Traducir a IDs').first().json;
const token = $('Entrar a SIGEV').first().json.token;
const conversationId = $('Cuando lo llama el agente').first().json.conversationId;

// Guarda la precotización en el chat y hace que el servidor mande el mensaje con el código. Devuelve el código o null.
const guardarPrecotizacion = async (precio, servicio) => {
  if (!conversationId || CHAT_API_KEY.startsWith('PEGA_')) return null;
  try {
    const r = await this.helpers.httpRequest({
      method: 'POST',
      url: `${CHAT_URL}/api/conversations/${conversationId}/precotizaciones`,
      headers: { 'x-api-key': CHAT_API_KEY, Accept: 'application/json' },
      body: {
        tramite: resumen.tramite, estado: resumen.estado, vehiculo: resumen.vehiculo, servicio,
        costo: precio.costo, mas_impuestos: precio.mas_impuestos, enviar_mensaje: true,
      },
      json: true,
      timeout: 10000,
    });
    return r.codigo || null;
  } catch (e) {
    return null; // si falla, Sandra da el precio igual (sin código)
  }
};

const leerPrecio = (cuerpo) => {
  const filas = cuerpo && cuerpo.success === true && Array.isArray(cuerpo.data) ? cuerpo.data : [];
  const costos = [...new Set(filas.map((f) => Number(f.costo)))];
  if (costos.length !== 1) return null; // sin precio, o varios distintos: no se adivina
  const fila = filas[0];
  return {
    costo: costos[0],
    precio: '$' + costos[0].toLocaleString('es-MX'),
    mas_impuestos: filas.some((f) => Number(f.mas_impuestos) === 1),
    tiempo_entrega: fila.tiempo_entrega || undefined,
    notas: fila.notas || undefined,
  };
};
const texto = (p) => `${p.precio}${p.mas_impuestos ? ' más impuestos' : ''}`
  + (p.tiempo_entrega ? `, entrega en ${p.tiempo_entrega}` : '')
  + (p.notas ? ` (nota: ${p.notas})` : '');

// --- Precio con el servicio pedido -----------------------------------------
if (respuesta.statusCode === 401) {
  return [{ json: { encontrado: false, ...resumen,
    mensaje: 'No se pudo entrar a SIGEV. No des ningún precio: dile al cliente que ese dato no lo tienes a la mano y ofrécele pasarlo con un asesor de GEVHE.' } }];
}

const pedido = respuesta.statusCode === 200 ? leerPrecio(respuesta.body) : null;
if (pedido && resumen.servicioIndicado) {
  const codigo = await guardarPrecotizacion(pedido, SERVICIOS[body.id_tiposervicio].clave);
  return [{ json: {
    encontrado: true, ...resumen, ...pedido, codigo,
    diferencias_servicios: DIFERENCIAS,
    mensaje: `Precio exacto con servicio ${resumen.servicio}: ${texto(pedido)}. Dáselo al cliente tal cual, mencionando trámite, estado, vehículo y servicio. Si pregunta en qué se diferencian los servicios, usa diferencias_servicios.` + conCodigo(codigo),
  } }];
}

// --- No hay precio: probar los otros servicios ------------------------------
const alternativas = [];
for (const [id, servicio] of Object.entries(SERVICIOS)) {
  if (Number(id) === body.id_tiposervicio) {
    // Ya se consultó en "Consultar costo"
    if (pedido) alternativas.push({ servicio: servicio.clave, descripcion: servicio.descripcion, ...pedido });
    continue;
  }
  try {
    const cuerpo = await this.helpers.httpRequest({
      method: 'POST',
      url: `${sigevUrl}/api/getCosto`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      body: { ...body, id_tiposervicio: Number(id) },
      json: true,
      timeout: 10000,
    });
    const p = leerPrecio(cuerpo);
    if (p) alternativas.push({ servicio: servicio.clave, descripcion: servicio.descripcion, ...p });
  } catch (e) {
    // SIGEV responde con error cuando no existe la combinación: ese servicio no está disponible
  }
}

if (alternativas.length && !resumen.servicioIndicado) {
  const lista = alternativas.map((a) => `${a.servicio} (${a.descripcion}) ${texto(a)}`).join('; ');
  const unico = alternativas.length === 1;
  // Con un solo servicio posible el precio ya está definido; con varios, se espera a que el cliente elija
  const codigo = unico ? await guardarPrecotizacion(alternativas[0], alternativas[0].servicio) : null;
  return [{ json: {
    encontrado: true, ...resumen, codigo,
    alternativas,
    diferencias_servicios: DIFERENCIAS,
    mensaje: unico
      ? `Precio exacto: ${lista}. Es el único servicio disponible para esta combinación. Dáselo al cliente tal cual, mencionando trámite, estado, vehículo y el servicio ${alternativas[0].servicio} con su descripción.` + conCodigo(codigo)
      : `Precios exactos por servicio: ${lista}. Dale al cliente las opciones de forma breve, con la diferencia entre ellas, y pregúntale cuál prefiere. Cuando elija, vuelve a llamar a cotizar_tramite con ese servicio.`,
  } }];
}

if (alternativas.length) {
  const lista = alternativas.map((a) => `${a.servicio} (${a.descripcion}) ${texto(a)}`).join('; ');
  return [{ json: {
    encontrado: false, ...resumen,
    alternativas,
    diferencias_servicios: DIFERENCIAS,
    mensaje: `Con servicio ${resumen.servicio} no se ofrece este trámite para ese estado y vehículo. Sí está disponible con: ${lista}. Díselo al cliente de forma breve, explícale la diferencia y pregúntale si le interesa. No ofrezcas el servicio ${resumen.servicio}. Si acepta otro servicio, vuelve a llamar a cotizar_tramite con ese servicio.`,
  } }];
}

return [{ json: {
  encontrado: false, ...resumen,
  mensaje: `SIGEV no tiene precio para ese trámite en ese estado y vehículo con ningún servicio. No des ningún precio: dile al cliente que ese dato no lo tienes a la mano y ofrécele pasarlo con un asesor de GEVHE.`,
} }];
