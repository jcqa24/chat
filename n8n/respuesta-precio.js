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

// Lo que Sandra debe decir siempre que da un precio.
const PRECOTIZACION = ' IMPORTANTE: aclara que es una precotización y que el costo final puede variar. Termina preguntándole si quiere continuar con el trámite.';

const respuesta = $input.first().json;
const { resumen, body, sigevUrl } = $('Traducir a IDs').first().json;
const token = $('Entrar a SIGEV').first().json.token;

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
  return [{ json: {
    encontrado: true, ...resumen, ...pedido,
    diferencias_servicios: DIFERENCIAS,
    mensaje: `Precio exacto con servicio ${resumen.servicio}: ${texto(pedido)}. Dáselo al cliente tal cual, mencionando trámite, estado, vehículo y servicio. Si pregunta en qué se diferencian los servicios, usa diferencias_servicios.` + PRECOTIZACION,
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
  return [{ json: {
    encontrado: true, ...resumen,
    alternativas,
    diferencias_servicios: DIFERENCIAS,
    mensaje: unico
      ? `Precio exacto: ${lista}. Es el único servicio disponible para esta combinación. Dáselo al cliente tal cual, mencionando trámite, estado, vehículo y el servicio ${alternativas[0].servicio} con su descripción.` + PRECOTIZACION
      : `Precios exactos por servicio: ${lista}. Dale al cliente las opciones de forma breve, con la diferencia entre ellas, y pregúntale cuál prefiere.` + PRECOTIZACION,
  } }];
}

if (alternativas.length) {
  const lista = alternativas.map((a) => `${a.servicio} (${a.descripcion}) ${texto(a)}`).join('; ');
  return [{ json: {
    encontrado: false, ...resumen,
    alternativas,
    diferencias_servicios: DIFERENCIAS,
    mensaje: `Con servicio ${resumen.servicio} no se ofrece este trámite para ese estado y vehículo. Sí está disponible con: ${lista}. Díselo al cliente de forma breve, explícale la diferencia y pregúntale si le interesa. No ofrezcas el servicio ${resumen.servicio}.` + PRECOTIZACION,
  } }];
}

return [{ json: {
  encontrado: false, ...resumen,
  mensaje: `SIGEV no tiene precio para ese trámite en ese estado y vehículo con ningún servicio. No des ningún precio: dile al cliente que ese dato no lo tienes a la mano y ofrécele pasarlo con un asesor de GEVHE.`,
} }];
