// Código del nodo "Respuesta para el agente" del sub-workflow cotizar_tramite (n8n).
// Recibe la respuesta completa de SIGEV /api/getCosto (Full Response) y la deja lista para el agente.

const respuesta = $input.first().json;
const { resumen } = $('Traducir a IDs').first().json;
const cuerpo = respuesta.body ?? {};
const filas = Array.isArray(cuerpo.data) ? cuerpo.data : [];

const noEncontrado = (motivo) => [{ json: {
  encontrado: false,
  ...resumen,
  mensaje: `${motivo} No des ningún precio: dile al cliente que ese dato no lo tienes a la mano y ofrécele pasarlo con un asesor de GEVHE.`,
} }];

if (respuesta.statusCode === 401) {
  return noEncontrado('No se pudo entrar a SIGEV (token inválido).');
}
if (respuesta.statusCode !== 200 || cuerpo.success !== true || filas.length === 0) {
  return noEncontrado(`SIGEV no tiene precio para esa combinación (${cuerpo.message ?? 'sin detalle'}).`);
}

// Debe haber un solo precio. Si SIGEV devolviera varios distintos, no se adivina.
const costos = [...new Set(filas.map((f) => Number(f.costo)))];
if (costos.length > 1) {
  return noEncontrado('SIGEV devolvió más de un precio para esa combinación.');
}

const costo = costos[0];
const masImpuestos = filas.some((f) => Number(f.mas_impuestos) === 1);

return [{ json: {
  encontrado: true,
  ...resumen,
  costo,
  precio: '$' + costo.toLocaleString('es-MX'),
  mas_impuestos: masImpuestos,
  mensaje: `Precio exacto: ${'$' + costo.toLocaleString('es-MX')}${masImpuestos ? ' más impuestos' : ''}. Dáselo al cliente tal cual, mencionando trámite, estado, vehículo y servicio.`,
} }];
