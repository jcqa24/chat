// Escenarios de conversación generados con los precios de SIGEV: uno por combinación, y se revisa
// que Sandra diga el precio correcto.
//
// Por defecto la plática es natural, como la de un cliente: primero dice el trámite ("Hola, necesito
// tramitar alta de placas") y luego contesta solo lo que Sandra le pregunta (estado, vehículo,
// vigencia, año, servicio). Con --directo pide todo en un solo mensaje.
//
//   npm run conversar -- precios --navegador                         (todas: tarda mucho)
//   npm run conversar -- precios --navegador --tramite 18            (solo licencias)
//   npm run conversar -- precios --navegador --estado CDMX --limite 5
//   npm run conversar -- precios --tramite VOE --directo             (todo en un mensaje)
//
// --tramite y --estado aceptan id o alias, varios separados por coma (LICEN,VOE · CDMX,EDOMEX).
// "npm run conversar -- tramites" lista los tipos de trámite con precio.

const { conectar, descargarCatalogo, agrupar, filtrar, vigenciaTexto, anioDe, describir, SERVICIOS } = require('./sigev-catalogo');

// $3,200 / $3200 / $ 3,200.00 → coincide con 3200 (y no con 32,000)
const reDelPrecio = (n) => {
  const conComas = Number(n).toLocaleString('en-US').replace(/,/g, ',?');
  return new RegExp(`\\$\\s?${conComas}(\\.00)?(?![\\d,])`);
};
const formato = (n) => '$' + Number(n).toLocaleString('es-MX');
const PRECIOS_RE = /\$\s?\d{1,3}(?:,?\d{3})*(?:\.\d+)?/g;
const numero = (txt) => Number(txt.replace(/[^\d.]/g, ''));
const SIN_PRECIO = /no lo tengo|no tengo (ese|el) dato|a la mano|asesor/i;

const minus = (s) => String(s ?? '').toLowerCase();

// Cómo lo diría un cliente
const frasesDe = (g) => {
  const estado = Number(g.id_entidad) === 15 ? 'en el estado de mexico' : `en ${minus(g.entidad_nombre)}`;
  const vehiculo = {
    AUTO: 'para un auto', MOTO: 'es una moto', CARGA: 'es de carga', REMOL: 'es un remolque',
    HIBRI: 'es un auto híbrido', ELEC: 'es un auto eléctrico', CLASI: 'es un auto clásico',
    DISCA: 'es un auto para persona con discapacidad',
  }[g.tipovehiculo_alias] ?? `es ${minus(g.tipovehiculo_nombre)}`;
  return {
    tramite: `Hola, necesito tramitar ${minus(g.tramite_nombre)}`,
    estado, vehiculo,
    vigencia: g.id_vigencia != null ? `de ${vigenciaTexto(g.id_vigencia)}` : null,
    anio: g.idmodelo_min != null ? `es modelo ${anioDe(g)}` : null,
    voluntaria: g.idmodelo_min != null ? (Number(g.voluntaria) ? 'sí, es voluntaria' : 'no es voluntaria') : null,
  };
};

// Lo que Sandra está preguntando en su último turno
const PREGUNTAS = [
  ['estado', /estado|entidad|d[oó]nde|ciudad/i],
  ['vehiculo', /veh[ií]culo|auto|moto|carro|carga|tipo de/i],
  ['vigencia', /vigencia|cu[aá]ntos a[nñ]os|por cu[aá]nto tiempo|a[nñ]os de/i],
  ['anio', /modelo|a[nñ]o (del|de tu|de su)|qu[eé] a[nñ]o/i],
  ['voluntaria', /voluntaria/i],
];
const PIDE_SERVICIO = /\b(VIP|XP|CL)\b/;

function mensajeDirecto(g) {
  const partes = [`hola, ¿cuánto cuesta ${minus(g.tramite_nombre)} en ${g.entidad_nombre} para ${minus(g.tipovehiculo_nombre)}`];
  if (g.id_vigencia != null) partes.push(`con vigencia ${vigenciaTexto(g.id_vigencia)}`);
  if (g.idmodelo_min != null) partes.push(`modelo ${anioDe(g)}${Number(g.voluntaria) ? ', es voluntaria' : ', no es voluntaria'}`);
  return partes.join(', ') + '?';
}

/**
 * Cliente que contesta lo que Sandra pregunta. responder(ctx) devuelve lo que escribe el cliente,
 * o { fin, revisar } cuando ya hubo precio (o no hay forma de llegar a él).
 */
function clienteNatural(g, precios) {
  const frases = frasesDe(g);
  const porServicio = Object.fromEntries(precios); // { VIP: 1800, XP: 2800, CL: 1300 }
  const elegido = porServicio.VIP != null ? 'VIP' : precios[0][0]; // el servicio que el cliente escoge
  const datos = ['estado', 'vehiculo', 'vigencia', 'anio', 'voluntaria'].filter((d) => frases[d]);

  return (ctx) => {
    const m = (ctx.memoria ??= { dados: new Set(), servicio: null, listado: false });
    if (ctx.turno === 0) return frases.tramite;

    const texto = ctx.ultimoTurno.join('\n');
    const mencionados = (texto.match(PRECIOS_RE) ?? []).map(numero);

    if (mencionados.length) {
      const revisar = [];
      if (mencionados.length > 1 && !m.servicio) {
        // Dio las opciones con precio: cada precio debe ser el de SIGEV, y el cliente escoge una
        for (const [s, c] of precios) revisar.push({ que: `en las opciones dice ${formato(c)} (${s})`, ok: reDelPrecio(c).test(texto) });
        m.servicio = elegido;
        m.listado = true;
        return { cliente: elegido.toLowerCase(), revisar };
      }
      // Un precio: el del servicio que escogió el cliente, o el que Sandra mencione
      const servicio = m.servicio
        ?? (precios.length === 1 ? precios[0][0] : (texto.match(/\b(VIP|XP|CL)\b/) ?? [])[1]);
      if (servicio && porServicio[servicio] != null) {
        revisar.push({ que: `dice ${formato(porServicio[servicio])} (${servicio})`, ok: reDelPrecio(porServicio[servicio]).test(texto) });
      } else {
        const ok = precios.some(([, c]) => reDelPrecio(c).test(texto));
        revisar.push({ que: `dice un precio de SIGEV (${precios.map(([s, c]) => `${s} ${formato(c)}`).join(', ')})`, ok });
      }
      revisar.push({ que: 'pregunta si quiere avanzar', ok: /avanzar|continuar|seguir/i.test(texto) });
      return { fin: true, revisar };
    }

    if (SIN_PRECIO.test(texto)) {
      return { fin: true, revisar: [{ que: `da el precio (dijo que no lo tiene: SIGEV sí tiene ${precios.map(([s, c]) => `${s} ${formato(c)}`).join(', ')})`, ok: false }] };
    }

    // Si ofrece VIP / XP / CL, escoger servicio
    if (PIDE_SERVICIO.test(texto)) {
      m.servicio = elegido;
      return elegido.toLowerCase();
    }
    // Contestar lo que pregunta (sin contar lo que Sandra repite: el trámite y el estado ya dados);
    // si no se entiende qué pide, dar el siguiente dato que falte
    const pregunta = texto
      .replace(new RegExp(minus(g.tramite_nombre).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[aeiou]/g, '.'), 'gi'), '')
      .replace(m.dados.has('estado') ? new RegExp(minus(g.entidad_nombre).replace(/[aeiou]/g, '.'), 'gi') : /$^/, '');
    let pide = PREGUNTAS.filter(([d, re]) => frases[d] && !m.dados.has(d) && re.test(pregunta)).map(([d]) => d);
    if (!pide.length) pide = datos.filter((d) => !m.dados.has(d)).slice(0, 1);
    if (!pide.length) pide = datos; // ya dio todo: lo repite junto
    pide.forEach((d) => m.dados.add(d));
    return pide.map((d) => frases[d]).join(', ');
  };
}

async function cargarEscenariosPrecios({ tramite, estado, limite, directo } = {}) {
  const { sigev } = await conectar();
  const { filas } = await descargarCatalogo(sigev);
  let grupos = agrupar(filtrar(filas, { tramite, estado }));
  if (limite) grupos = grupos.slice(0, Number(limite));

  const escenarios = {};
  for (const g of grupos) {
    // Solo los servicios con un precio único (si SIGEV tiene dos precios para lo mismo, no hay "correcto")
    const precios = [...g.servicios].filter(([, set]) => set.size === 1).map(([id, set]) => [SERVICIOS[id], [...set][0]]);
    if (!precios.length) continue;
    const nombre = `precio ${describir(g)}`;
    const descripcion = precios.map(([s, c]) => `${s} ${formato(c)}`).join(', ');
    escenarios[nombre] = directo
      ? {
        descripcion,
        pasos: [{
          cliente: mensajeDirecto(g),
          // Un servicio: ese precio. Varios: debe mencionar el precio de cada uno
          debe: precios.map(([s, c]) => ({ que: `dice ${formato(c)} (${s})`, re: reDelPrecio(c) })),
        }],
        tipo: g.tramite_nombre,
      }
      : { descripcion, responder: clienteNatural(g, precios), tipo: g.tramite_nombre };
  }
  return escenarios;
}

module.exports = { cargarEscenariosPrecios };
