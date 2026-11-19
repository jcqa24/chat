// Conversaciones de prueba con Sandra. Cada paso es lo que escribe el cliente y, opcionalmente,
// lo que debe pasar en las respuestas de ese turno (se revisa con expresiones regulares: la IA
// nunca responde igual, así que se revisa lo importante, no el texto exacto).
//
//   cliente: texto, o función (ctx) => texto  (ctx.correo es un correo único por corrida)
//   debe:    [{ que: 'descripción', re: /regex/ }]  → alguna respuesta del turno debe cumplirlo
//   noDebe:  [{ que: 'descripción', re: /regex/ }]  → ninguna respuesta del turno debe cumplirlo

const PRECIO = /\$\s?\d{1,3}(,\d{3})*(\.\d+)?/;
const PREGUNTA_AVANZAR = /avanzar|continuar|seguir/i;
const CODIGO_PRE = /\[copiar\]PRE\d{7}\[\/copiar\]/;
const CODIGO_TRAMITE = /\[copiar\](COT[A-Z]?\d+|A\d+)\[\/copiar\]/;
const PIDE_CORREO = /correo/i;
// Sandra inventando que lo pasa con un asesor (el único aviso válido de asesor lo manda el servidor:
// "Un asesor se contactará contigo por medio de nuestra app")
const ASESOR_INVENTADO = /(conecto|paso|comunico|pondr[eé] en contacto|contactar[aá]n?)\b.{0,40}asesor|asesor.{0,40}(te contactar[aá]|se pondr[aá] en contacto|te llamar[aá])/i;

const precioYPregunta = [
  { que: 'da un precio', re: PRECIO },
  { que: 'pregunta si quiere avanzar', re: PREGUNTA_AVANZAR },
];

module.exports = {
  // Licencia: precio → "sí" → (costo fijo) nombre y correo → código del trámite,
  //                              (sin costo fijo) asesor + código PRE
  'licencia-acepta': {
    descripcion: 'Licencia CDMX moto 3 años, acepta y da sus datos',
    pasos: [
      { cliente: 'hola, necesito una licencia de conducir' },
      { cliente: 'cdmx' },
      { cliente: 'para moto' },
      { cliente: '3 años', debe: precioYPregunta, noDebe: [{ que: 'no manda códigos con el precio', re: /\[copiar\]/ }] },
      {
        cliente: 'sí, quiero continuar',
        debe: [{ que: 'pide correo (costo fijo) o manda código PRE (sin costo fijo)', re: new RegExp(`${PIDE_CORREO.source}|${CODIGO_PRE.source}`, 'i') }],
        noDebe: [{ que: 'no inventa "te conecto con un asesor"', re: ASESOR_INVENTADO }],
      },
      {
        cliente: (ctx) => `Ana Prueba López, ${ctx.correo}`,
        soloSi: (ctx) => ctx.ultimoTurno.some((m) => PIDE_CORREO.test(m)), // solo si Sandra pidió los datos
        debe: [{ que: 'manda el código del trámite con botón copiar', re: CODIGO_TRAMITE }],
      },
    ],
  },

  // Variaciones: "órale", pregunta antes de contestar, y nombre y correo en mensajes separados
  'licencia-datos-separados': {
    descripcion: 'Licencia CDMX moto: pregunta algo, dice "órale" y da nombre y correo por separado',
    pasos: [
      { cliente: 'hola, ocupo licencia para moto en cdmx' },
      { cliente: '3 años', debe: precioYPregunta },
      { cliente: '¿y cuánto tarda?', noDebe: [{ que: 'una pregunta no dispara el flujo', re: /\[copiar\]|nombre completo/i }] },
      {
        cliente: 'órale',
        debe: [{ que: 'pide correo (costo fijo) o manda código PRE (sin costo fijo)', re: new RegExp(`${PIDE_CORREO.source}|${CODIGO_PRE.source}`, 'i') }],
        noDebe: [{ que: 'no inventa lo del asesor', re: ASESOR_INVENTADO }],
      },
      {
        cliente: 'Ana Prueba López',
        soloSi: (ctx) => ctx.ultimoTurno.some((m) => PIDE_CORREO.test(m)),
        debe: [{ que: 'pide el correo que falta', re: PIDE_CORREO }],
      },
      {
        cliente: (ctx) => ctx.correo,
        soloSi: (ctx) => ctx.ultimoTurno.some((m) => PIDE_CORREO.test(m)),
        debe: [{ que: 'manda el código del trámite con botón copiar', re: CODIGO_TRAMITE }],
      },
    ],
  },

  'licencia-rechaza': {
    descripcion: 'Licencia Edomex auto 2 años y dice que no',
    pasos: [
      { cliente: 'buenas, quiero sacar mi licencia' },
      { cliente: 'estado de méxico' },
      { cliente: 'auto' },
      { cliente: '2 años', debe: precioYPregunta },
      {
        cliente: 'no, gracias',
        debe: [{ que: 'responde amable', re: /aqu[ií] estoy|cambias de opini[oó]n|cuando quieras/i }],
        noDebe: [
          { que: 'no manda códigos', re: /\[copiar\]/ },
          { que: 'no vuelve a dar el precio', re: PRECIO },
        ],
      },
    ],
  },

  'pregunta-servicio': {
    descripcion: 'Pide que le expliquen el servicio después del precio',
    pasos: [
      { cliente: 'hola, cuánto cuesta la licencia para moto en cdmx' },
      { cliente: '3 años', debe: precioYPregunta },
      { cliente: '¿qué incluye ese servicio?', debe: [{ que: 'explica el servicio', re: /delegaci|todo por ti|acudir/i }] },
    ],
  },

  'tarjeta-reposicion': {
    descripcion: 'Reposición de tarjeta de circulación en Edomex (varios servicios)',
    pasos: [
      { cliente: 'perdí mi tarjeta de circulación' },
      { cliente: 'edomex' },
      { cliente: 'es un carro', debe: [{ que: 'da precio(s)', re: PRECIO }] },
    ],
  },
};
