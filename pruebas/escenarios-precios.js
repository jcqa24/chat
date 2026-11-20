// Escenarios de conversación generados con los precios de SIGEV: por cada combinación, el cliente
// pide el precio en un solo mensaje y se revisa que Sandra diga el precio correcto.
//
//   npm run conversar -- precios --navegador                         (todas: tarda mucho)
//   npm run conversar -- precios --navegador --tramite 18            (solo licencias)
//   npm run conversar -- precios --navegador --estado CDMX --limite 5
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

function mensajeDe(g) {
  const partes = [`hola, ¿cuánto cuesta ${String(g.tramite_nombre).toLowerCase()} en ${g.entidad_nombre} para ${String(g.tipovehiculo_nombre).toLowerCase()}`];
  if (g.id_vigencia != null) partes.push(`con vigencia ${vigenciaTexto(g.id_vigencia)}`);
  if (g.idmodelo_min != null) partes.push(`modelo ${anioDe(g)}${Number(g.voluntaria) ? ', es voluntaria' : ', no es voluntaria'}`);
  return partes.join(', ') + '?';
}

async function cargarEscenariosPrecios({ tramite, estado, limite } = {}) {
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
    escenarios[nombre] = {
      descripcion: precios.map(([s, c]) => `${s} ${formato(c)}`).join(', '),
      pasos: [{
        cliente: mensajeDe(g),
        // Un servicio: ese precio. Varios: debe mencionar el precio de cada uno
        debe: precios.map(([s, c]) => ({ que: `dice ${formato(c)} (${s})`, re: reDelPrecio(c) })),
      }],
      tipo: g.tramite_nombre, // agrupa el reporte por tipo de trámite
    };
  }
  return escenarios;
}

module.exports = { cargarEscenariosPrecios };
