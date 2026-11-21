// Código del nodo "Respuesta para el agente" del sub-workflow cotizar_tramite (n8n).
// Recibe la respuesta completa de SIGEV /api/getCosto (Full Response) y la deja lista para el agente.
// Si no hay precio con el servicio pedido, consulta los otros servicios (VIP, XP, CL) para ofrecérselos al cliente.
//
// Flujo: Sandra da el precio y pregunta "¿Te gustaría avanzar con eso?". El precio se registra en el chat
// (POST /api/conversations/:id/cotizacion) y el servidor del chat resuelve la respuesta del cliente
// (sí / no / nombre y correo). Aquí ya NO se guarda la precotización ni se manda ningún código.

// Qué incluye cada servicio (descripciones de cat_tiposervicio en SIGEV).
const SERVICIOS = {
  1: { clave: 'VIP', descripcion: 'No pones un pie en la Delegación: GEVHE hace todo por ti.' },
  2: { clave: 'XP', descripcion: 'Servicio XP (pendiente de descripción).' }, // ← pon aquí qué incluye XP
  3: { clave: 'CL', descripcion: 'Para concluir el trámite tienes que acudir tú a la Delegación.' },
};
const ID_SERVICIO = { VIP: 1, XP: 2, CL: 3 };
const DIFERENCIAS = Object.values(SERVICIOS).map((s) => `${s.clave}: ${s.descripcion}`).join(' | ');

// La URL y la clave del chat NO van aquí: se leen del nodo "Configuración" (chatUrl, chatApiKey),
// así este código se puede volver a pegar sin perderlas.
const config = (() => {
  try { return $('Configuración').first().json; } catch (e) { return {}; } // sin nodo Configuración: no se registra
})();
const CHAT_URL = String(config.chatUrl ?? '').trim().replace(/\/+$/, '');
const CHAT_API_KEY = String(config.chatApiKey ?? '').trim();

// Lo que Sandra hace siempre que da un precio definido.
const AL_DAR_PRECIO = ' Da el precio UNA sola vez, en un solo mensaje, aclarando que es una precotización y que el costo final puede variar.'
  + ' Menciona el servicio solo por su nombre: NO expliques qué incluye ni en qué se diferencia de los otros, salvo que el cliente lo pregunte (entonces usa diferencias_servicios).'
  + ' No escribas ningún código.'
  + ' Termina preguntando: "¿Te gustaría avanzar con eso?".'
  + ' NO digas nada de asesores, códigos, la app ni de los siguientes pasos: cuando el cliente conteste, el sistema se encarga.';

let respuesta = $input.first().json; // puede cambiar: licencias con una sola vigencia se vuelven a consultar
const { resumen, body, sigevUrl } = $('Traducir a IDs').first().json;
const token = $('Entrar a SIGEV').first().json.token;
const conversationId = $('Cuando lo llama el agente').first().json.conversationId;

// Registra en el chat el precio que se le va a dar al cliente (todavía no es precotización).
// Si falla, el motivo queda en error_registro (sale en la salida del nodo) y Sandra da el precio igual.
let errorRegistro = null;
const registrarCotizacion = async (precio, servicioClave) => {
  if (!CHAT_URL || !CHAT_API_KEY) { errorRegistro = 'Falta chatUrl o chatApiKey en el nodo Configuración'; return; }
  if (!conversationId) { errorRegistro = 'Falta conversationId (revisa la herramienta cotizar_tramite en el AI Agent)'; return; }
  try {
    await this.helpers.httpRequest({
      method: 'POST',
      url: `${CHAT_URL}/api/conversations/${conversationId}/cotizacion`,
      headers: { 'x-api-key': CHAT_API_KEY, Accept: 'application/json' },
      body: {
        tramite: resumen.tramite, id_tramite: resumen.id_tramite, nombre_tramite: resumen.nombre_tramite,
        estado: resumen.estado, vehiculo: resumen.vehiculo, servicio: servicioClave,
        costo: precio.costo, mas_impuestos: precio.mas_impuestos,
        sigev: { ...(resumen.sigev ?? {}), tipo_servicio: `${ID_SERVICIO[servicioClave]}-${servicioClave}` },
      },
      json: true,
      timeout: 10000,
    });
  } catch (e) {
    const estado = e.httpCode ?? e.response?.status ?? e.statusCode;
    errorRegistro = `No se pudo registrar en ${CHAT_URL} (conversación ${conversationId})`
      + (estado ? `: HTTP ${estado}` : '') + ` ${e.message ?? ''}`.trimEnd()
      + (String(estado) === '401' ? ' → chatApiKey incorrecta' : '')
      + (String(estado) === '404' ? ' → esa conversación no existe en ese servidor (¿chatUrl de otro servidor?)' : '');
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

// Respuesta con un precio definido (ya registrado en el chat)
const conPrecio = async (precio, servicioClave, extra = '') => {
  await registrarCotizacion(precio, servicioClave);
  return [{ json: {
    encontrado: true, ...resumen, ...precio, servicio: servicioClave,
    diferencias_servicios: DIFERENCIAS, error_registro: errorRegistro ?? undefined,
    mensaje: `Precio exacto con servicio ${servicioClave}: ${texto(precio)}.${extra}${avisoVigencia} Dáselo al cliente mencionando trámite, estado, vehículo y servicio.` + AL_DAR_PRECIO,
  } }];
};

// --- Precio con el servicio pedido -----------------------------------------
if (respuesta.statusCode === 401) {
  return [{ json: { encontrado: false, ...resumen,
    mensaje: 'No se pudo entrar a SIGEV. No des ningún precio: dile al cliente que ese dato no lo tienes a la mano y ofrécele pasarlo con un asesor de GEVHE.' } }];
}

// --- Licencias: las vigencias salen de SIGEV, no de lo que Sandra crea --------
// Cada estado y vehículo tiene sus vigencias (CDMX auto: solo permanente). Si el cliente no dijo la
// vigencia o pidió una que no existe, se consulta el catálogo de licencias de SIGEV.
let avisoVigencia = '';
if (resumen.esLicencia) {
  const textoVigencia = (id) => (Number(id) === 99 ? 'permanente' : `${id} ${Number(id) === 1 ? 'año' : 'años'}`);
  let catalogo = [];
  try {
    const cuerpo = await this.helpers.httpRequest({
      method: 'POST',
      url: `${sigevUrl}/api/getCatalogoCostosLicencias`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      body: {},
      json: true,
      timeout: 10000,
    });
    catalogo = Array.isArray(cuerpo?.data) ? cuerpo.data : [];
  } catch (e) {
    catalogo = []; // sin catálogo: se sigue con lo que respondió getCosto
  }

  // Estado y/o vehículo sin decir: si con lo que dijo el cliente solo hay una opción en SIGEV, se
  // completa sola (licencia permanente → CDMX, automóvil); si hay varias, se pregunta solo por esas.
  if (catalogo.length && (resumen.faltaEstado || resumen.faltaVehiculo)) {
    const coincide = (f, conVigencia) => Number(f.id_tipotramite) === body.id_tramite
      && (resumen.faltaEstado || Number(f.id_entidad) === body.id_entidad)
      && (resumen.faltaVehiculo || Number(f.id_tipovehiculo) === body.id_tipovehiculo)
      && (!conVigencia || Number(f.id_vigencia) === body.id_vigencia);
    let opciones = catalogo.filter((f) => coincide(f, resumen.vigenciaIndicada));
    let sinEsaVigencia = '';
    if (!opciones.length && resumen.vigenciaIndicada) {
      sinEsaVigencia = `No hay ${resumen.nombre_tramite} con vigencia ${textoVigencia(body.id_vigencia)}`
        + `${resumen.faltaEstado ? '' : ` en ${resumen.estado}`}. `;
      opciones = catalogo.filter((f) => coincide(f, false));
    }
    const unicos = (filas, id, nombre) => [...new Map(filas.map((f) => [Number(f[id]), f])).values()]
      .map((f) => String(f[nombre]));
    const conVigencia = resumen.vigenciaIndicada && !sinEsaVigencia ? ` ${textoVigencia(body.id_vigencia)}` : '';

    if (opciones.length && resumen.faltaEstado) {
      const estados = unicos(opciones, 'id_entidad', 'entidad_nombre');
      if (estados.length > 1) {
        return [{ json: {
          encontrado: false, ...resumen, estados_disponibles: estados,
          mensaje: `${sinEsaVigencia}En SIGEV hay ${resumen.nombre_tramite}${conVigencia} en: ${estados.join(', ')}. `
            + 'Pregúntale al cliente en cuál de esos estados la necesita (menciona solo esos). No des ningún precio todavía. '
            + 'Cuando conteste, vuelve a llamar a cotizar_tramite con ese estado.',
        } }];
      }
      const f = opciones[0];
      body.id_entidad = Number(f.id_entidad);
      resumen.estado = f.entidad_nombre;
      resumen.sigev = { ...(resumen.sigev ?? {}), entidad: `${f.id_entidad}-${f.entidad_alias}` };
      opciones = opciones.filter((x) => Number(x.id_entidad) === body.id_entidad);
      avisoVigencia += ` Solo existe en ${f.entidad_nombre}: díselo al cliente y no le preguntes el estado.`;
    }
    if (opciones.length && resumen.faltaVehiculo) {
      const vehiculos = unicos(opciones, 'id_tipovehiculo', 'tipovehiculo_nombre').map((v) => v.toLowerCase());
      if (vehiculos.length > 1) {
        return [{ json: {
          encontrado: false, ...resumen, vehiculos_disponibles: vehiculos.join(', '),
          mensaje: `${sinEsaVigencia}En ${resumen.estado} hay ${resumen.nombre_tramite}${conVigencia} para: ${vehiculos.join(', ')}. `
            + 'Pregúntale al cliente para cuál la necesita (menciona solo esos). No des ningún precio todavía. '
            + 'Cuando conteste, vuelve a llamar a cotizar_tramite con ese vehículo y el estado.',
        } }];
      }
      const f = opciones[0];
      body.id_tipovehiculo = Number(f.id_tipovehiculo);
      resumen.vehiculo = String(f.tipovehiculo_nombre).toLowerCase();
      resumen.sigev = { ...(resumen.sigev ?? {}), tipo_vehiculo: `${f.id_tipovehiculo}-${f.tipovehiculo_alias}` };
      avisoVigencia += ` Solo existe para ${resumen.vehiculo}: díselo al cliente y no le preguntes el tipo de vehículo.`;
    }
    respuesta = { statusCode: 0, body: null }; // se consultó sin estado/vehículo: se vuelve a cotizar abajo
  }

  const delEstado = catalogo.filter((f) => Number(f.id_tipotramite) === body.id_tramite && Number(f.id_entidad) === body.id_entidad);
  const delVehiculo = delEstado.filter((f) => Number(f.id_tipovehiculo) === body.id_tipovehiculo);
  const vigencias = [...new Set(delVehiculo.map((f) => Number(f.id_vigencia)))].sort((a, b) => a - b);

  if (catalogo.length && delEstado.length && !delVehiculo.length) {
    // Hay licencias en ese estado, pero no para ese vehículo
    const vehiculos = [...new Set(delEstado.map((f) => String(f.tipovehiculo_nombre).toLowerCase()))].join(', ');
    return [{ json: {
      encontrado: false, ...resumen, vehiculos_disponibles: vehiculos,
      mensaje: `En ${resumen.estado} SIGEV no tiene ${resumen.nombre_tramite} para ${resumen.vehiculo}; solo para: ${vehiculos}. Díselo al cliente y pregúntale si le sirve alguno de esos. No des ningún precio todavía.`,
    } }];
  }

  if (vigencias.length && !vigencias.includes(body.id_vigencia)) {
    const pidio = resumen.vigenciaIndicada || resumen.vigenciaPedida
      ? `No hay vigencia de ${resumen.vigenciaPedida ?? textoVigencia(body.id_vigencia)} para ese estado y vehículo. `
      : '';
    if (vigencias.length === 1) {
      // Una sola vigencia: esa es, se cotiza directo
      body.id_vigencia = vigencias[0];
      resumen.vigencia = textoVigencia(vigencias[0]);
      avisoVigencia += ` ${pidio}La única vigencia disponible en ${resumen.estado} para ${resumen.vehiculo} es ${resumen.vigencia}: menciónala (no ofrezcas otras vigencias).`;
      try {
        const cuerpo = await this.helpers.httpRequest({
          method: 'POST',
          url: `${sigevUrl}/api/getCosto`,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          body,
          json: true,
          timeout: 10000,
        });
        respuesta = { statusCode: 200, body: cuerpo };
      } catch (e) {
        respuesta = { statusCode: e.httpCode ?? 404, body: null };
      }
    } else {
      // Varias: el cliente escoge entre las que existen (con su precio)
      const opciones = vigencias.map((v) => {
        const precios = delVehiculo.filter((f) => Number(f.id_vigencia) === v)
          .map((f) => `${f.tiposervicio_nombre} $${Number(f.costo).toLocaleString('es-MX')}`);
        return `${textoVigencia(v)}: ${[...new Set(precios)].join(' / ')}`;
      }).join('; ');
      return [{ json: {
        encontrado: false, ...resumen,
        vigencias_disponibles: vigencias.map(textoVigencia),
        mensaje: `${pidio}Vigencias disponibles en SIGEV para ${resumen.nombre_tramite} en ${resumen.estado} para ${resumen.vehiculo}: ${opciones}. `
          + 'Pregúntale al cliente cuál vigencia quiere, mencionando SOLO estas opciones con su precio (no ofrezcas ninguna otra vigencia). '
          + 'Cuando elija, vuelve a llamar a cotizar_tramite con esa vigencia. Todavía no le preguntes si quiere avanzar.',
      } }];
    }
  }
}

const pedido = respuesta.statusCode === 200 ? leerPrecio(respuesta.body) : null;
if (pedido && resumen.servicioIndicado) {
  return await conPrecio(pedido, SERVICIOS[body.id_tiposervicio].clave);
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

// Un solo servicio posible: ese es el precio
if (alternativas.length === 1) {
  const [unica] = alternativas;
  const aviso = resumen.servicioIndicado
    ? ` Para esa combinación el único servicio disponible es ${unica.servicio} (no menciones ${resumen.servicio}).`
    : ' Es el único servicio disponible para esta combinación.';
  return await conPrecio(unica, unica.servicio, aviso);
}

// Varios servicios: el cliente elige y se vuelve a cotizar con ese servicio
if (alternativas.length) {
  const lista = alternativas.map((a) => `${a.servicio} (${a.descripcion}) ${texto(a)}`).join('; ');
  const intro = resumen.servicioIndicado
    ? `Con servicio ${resumen.servicio} no se ofrece este trámite para ese estado y vehículo. Sí está disponible con: ${lista}. No ofrezcas el servicio ${resumen.servicio}.`
    : `Precios exactos por servicio: ${lista}.`;
  return [{ json: {
    encontrado: !resumen.servicioIndicado, ...resumen,
    alternativas,
    diferencias_servicios: DIFERENCIAS,
    mensaje: `${intro}${avisoVigencia} Dale al cliente las opciones de forma breve, con la diferencia entre ellas, y pregúntale cuál prefiere. Cuando elija, vuelve a llamar a cotizar_tramite con ese servicio. Todavía no le preguntes si quiere avanzar.`,
  } }];
}

return [{ json: {
  encontrado: false, ...resumen,
  mensaje: `SIGEV no tiene precio para ese trámite en ese estado y vehículo con ningún servicio. No des ningún precio: dile al cliente que ese dato no lo tienes a la mano y ofrécele pasarlo con un asesor de GEVHE.`,
} }];
