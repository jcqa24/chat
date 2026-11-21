// Código del nodo "Traducir a IDs" del sub-workflow cotizar_tramite (n8n).
// Convierte lo que manda el agente (nombres legibles) en los IDs que pide SIGEV /api/getCosto.
// Catálogos tomados de SIGEV (cat_tramite, cat_entidad, cat_tipovehiculo, cat_tiposervicio,
// cat_vigencia, cat_modelo). Si SIGEV agrega trámites o estados, hay que agregarlos aquí.

const SIGEV_URL = 'https://my.grupogevhe.com'; // ← URL de SIGEV, sin "/" al final

// Los datos se leen del trigger (no de $input): así da igual qué nodos haya en medio (p. ej. "Configuración").
const entrada = $('Cuando lo llama el agente').first().json;

const norm = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z0-9/ ]/g, ' ').replace(/\s+/g, ' ').trim();

const TRAMITES = {
  VOE: 3, 'VEHICULO DE OTRA ENTIDAD': 3,
  BYA: 4, 'BAJA Y ALTA': 4, 'BAJA Y ALTA DE PLACAS': 4,
  REE: 5, REEMPLACAMIENTO: 5,
  BAJA: 6, 'BAJA DE PLACAS': 6,
  ALTA: 7, 'ALTA DE PLACAS': 7,
  NVO: 8, 'VEHICULO NUEVO': 8,
  RENOV: 9, 'RENOVACION DE TARJETA': 9,
  CAMPRO: 10, 'CAMBIO DE PROPIETARIO': 10,
  REPTAR: 11, 'REPOSICION DE TARJETA': 11,
  SITCRIT: 12, 'SITUACION CRITICA': 12,
  ACLARACION: 13, 'CORRECCION EN SISTEMA': 13,
  CRC: 14, 'REIMPRESION DE REGISTRO DE TRAMITE': 14,
  RPV: 15, REPUVE: 15,
  INVEPL: 16, 'INVESTIGACION DE PLACA': 16,
  VERI: 17, VERIFICACION: 17,
  LICEN: 18, LICENCIA: 18, 'LICENCIA DE MANEJO': 18,
  ANTRA: 19, 'PERMISO DE CARGA': 19,
  PERMI: 20, 'PERMISO PARA CIRCULAR SIN PLACAS': 20,
  DESBLOQ: 21, DESBLOQUEO: 21,
  CONCLU: 22, 'CONCLUSION DE TRAMITE': 22,
  REFAC: 23, REFACTURACION: 23,
  FACO: 24, 'FACTURA DE ORIGEN': 24,
  ACTA: 25, 'CONSTANCIA DE EXTRAVIO O ROBO': 25,
  CERTIPG: 26, 'VALIDACION DE PAGOS': 26,
  VENTA: 27, 'AVISO DE VENTA': 27,
  EXT: 29, 'VEHICULO EXTRANJERO': 29,
  REPLICEN: 30, 'REPOSICION DE LICENCIA': 30,
  LINEA: 31, 'LINEA DE CAPTURA': 31,
  BORRON: 33, 'BORRON Y CUENTA NUEVA': 33,
  ACTUALIZACION: 34,
  ACTIVACION: 35,
  PERMICARGA: 38, 'PERMISO DE CARGA EDOMEX': 38,
  REIMP: 40, 'REIMPRESION DE TARJETA': 40,
  CONSTANCIA: 42, 'CERTIFICADO DE MANEJO': 42,
  LICENMNR: 43, 'PERMISO PARA MENOR': 43,
  LICENSC: 44, 'LICENCIA SIN CONSTANCIA': 44,
  MUNDIAL: 45, 'PLACAS EDICION ESPECIAL': 45,
  'CONSTANCIA EXT': 46, 'CONSTANCIA DE EXTRAVIO': 46,
  // Nombres oficiales de SIGEV (cat_tramite.tramite_nombre) y formas comunes de decirlos
  'ALTA DE SERIE EN REPUVE SOLO SERIE 17 DIGITOS': 15, 'ALTA DE SERIE EN REPUVE': 15, 'ALTA EN REPUVE': 15,
  'CUALQUIER TIPO DE DESBLOQUEO': 21, 'DESBLOQUEO DE PLACAS': 21, 'DESBLOQUEO DE VEHICULO': 21,
  'CONCLUSION DE TRAMITE EN DELEGACION': 22, 'CONCLUSION DE TRAMITE': 22,
  'REFACTURACION DE VEHICULO': 23, 'REFACTURAR': 23,
  'VALIDACION DE PAGOS GUBERNAMENTALES': 26,
  'AVISO DE VENTA PORTAL': 27,
  'LINEA DE CAPTURA PARA CUALQUIER TIPO DE MULTA': 31, 'LINEA DE CAPTURA DE MULTA': 31, 'PAGO DE MULTA': 31,
  'PLACA QUE SE QUEDA ACTIVA POR ERROR EN SISTEMA': 34, 'PLACA ACTIVA POR ERROR': 34,
  'SE REALIZA ACTIVACION DE PLACA QUE APARECE DADA DE BAJA QUE EL CONTRIBUYENTE DESCONOCE': 35, 'ACTIVACION DE PLACA': 35,
  'CERTIFICADO DE MANEJO PARA MOTO': 42, 'CERTIFICADO DE MANEJO': 42,
  'PERMISO DE CONDUCIR PARA MENOR': 43, 'LICENCIA PARA MENOR': 43, 'PERMISO DE MENOR': 43,
  'LICENCIA DE MANEJO SIN CONSTANCIA': 44,
  'ALTA DE PLACAS EDICION ESPECIAL': 45, 'PLACAS MUNDIALISTAS': 45,
  'LICENCIA DE CONDUCIR': 18, 'LICENCIA PARA CONDUCIR': 18, 'LICENCIA DE AUTO': 18, 'LICENCIA DE MOTO': 18,
  'REPOSICION DE LICENCIA VIGENTE': 30, 'VERIFICACION VEHICULAR': 17,
  'RENOVACION DE TARJETA DE CIRCULACION': 9, 'REPOSICION DE TARJETA DE CIRCULACION': 11, 'REIMPRESION DE TARJETA DE CIRCULACION': 40,
};
// El agente puede escribir el trámite de muchas formas ("reimpresión de tarjeta de circulación",
// "reimprimir mi tarjeta", "perdí la tarjeta"...). Primero se busca exacto y luego por palabras clave.
const PALABRAS_RELLENO = /\b(DE|DEL|LA|EL|LOS|LAS|MI|SU|UNA|UN|PARA|CIRCULACION|VEHICULAR|TRAMITE)\b/g;
const REGLAS_TRAMITE = [
  [/OTRA ENTIDAD/, /./, 3], // "alta de vehículo de otra entidad", "placas de otra entidad"
  [/EXTRANJER/, /./, 29],
  [/NUEV[OA]/, /PLACA|ALTA|EMPLAC|VEHICULO|AUTO|CARRO|MOTO/, 8], // "alta de placas para vehículo nuevo"
  [/REIMPR/, /TARJETA/, 40],
  [/REPOSIC|PERDI|EXTRAVI|ROBAR|ROBO/, /TARJETA/, 11],
  [/RENOV|VENCID|ACTUALIZ/, /TARJETA/, 9],
  [/REPOSIC|PERDI|EXTRAVI/, /LICENCIA/, 30],
  [/PERMISO/, /SIN PLACA/, 20],
  [/BAJA/, /ALTA/, 4],
  [/CAMBIO/, /PROPIETARI|DUENO|NOMBRE/, 10],
];
// Errores de dedo y formas comunes que se corrigen antes de buscar
const CORRECCIONES = [
  [/\b(VEICULO|BEHICULO|VEHICLO|VEHICUO|VEHIULO)S?\b/g, 'VEHICULO'],
  [/\b(CARRO|COCHE|AUTO|AUTOMOVIL|MOTO|CAMIONETA|VEHICULO)S? (DE|DEL|EN|DE UN) OTRO ESTADO\b/g, 'VEHICULO DE OTRA ENTIDAD'],
  [/\bDE OTRO ESTADO\b/g, 'DE OTRA ENTIDAD'],
  [/\b(PLACAS|AUTO|CARRO|VEHICULO) FORANE[OA]S?\b/g, 'VEHICULO DE OTRA ENTIDAD'],
];
const corregir = (v) => CORRECCIONES.reduce((t, [re, por]) => t.replace(re, por), v);

// Nombres de 2 palabras o más, del más largo al más corto: para encontrarlos DENTRO de una frase
// ("alta de vehículo de otra entidad" contiene "vehículo de otra entidad")
const NOMBRES_LARGOS = Object.keys(TRAMITES).filter((k) => k.includes(' ')).sort((a, b) => b.length - a.length);
const contienePalabras = (texto, nombre) => ` ${texto} `.includes(` ${nombre} `);

const buscarTramite = (valor) => {
  const v = corregir(norm(valor));
  if (!v) return null;
  if (TRAMITES[v]) return TRAMITES[v];
  const corto = v.replace(PALABRAS_RELLENO, ' ').replace(/\s+/g, ' ').trim();
  if (TRAMITES[corto]) return TRAMITES[corto];
  for (const [a, b, id] of REGLAS_TRAMITE) if (a.test(v) && b.test(v)) return id;
  const conDe = Object.keys(TRAMITES).find((k) => k.length > 5 && norm(k.replace(/ DE /g, ' ')) === corto);
  if (conDe) return TRAMITES[conDe];
  // El nombre de un trámite dentro de la frase (gana el más largo)
  const dentro = NOMBRES_LARGOS.find((k) => contienePalabras(v, k) || contienePalabras(corto, norm(k.replace(/ DE /g, ' '))));
  return dentro ? TRAMITES[dentro] : null;
};
// Nombre oficial de cada trámite (cat_tramite.tramite_nombre en SIGEV): se guarda en la precotización.
const NOMBRE_OFICIAL = {
  3: 'Vehículo de otra entidad', 4: 'Baja y alta de placas', 5: 'Reemplacamiento', 6: 'Baja de placas',
  7: 'Alta de placas', 8: 'Vehículo nuevo', 9: 'Renovación de tarjeta', 10: 'Cambio de propietario',
  11: 'Reposición de tarjeta', 12: 'Situación crítica', 13: 'Corrección en sistema',
  14: 'Reimpresión de registro de trámite', 15: 'Alta de serie en REPUVE', 16: 'Investigación de placa',
  17: 'Verificación vehicular', 18: 'Licencia de manejo', 19: 'Permiso de carga',
  20: 'Permiso para circular sin placas', 21: 'Desbloqueo', 22: 'Conclusión de trámite en delegación',
  23: 'Refacturación de vehículo', 24: 'Factura de origen', 25: 'Constancia de extravío o robo',
  26: 'Validación de pagos gubernamentales', 27: 'Aviso de venta portal', 29: 'Vehículo extranjero',
  30: 'Reposición de licencia vigente', 31: 'Línea de captura de multas', 33: 'Borrón y cuenta nueva',
  34: 'Actualización de placa activa por error', 35: 'Activación de placa', 38: 'Permiso de carga EDOMEX',
  40: 'Reimpresión de tarjeta de circulación', 42: 'Certificado de manejo para moto',
  43: 'Permiso de conducir para menor', 44: 'Licencia de manejo sin constancia',
  45: 'Alta de placas edición especial', 46: 'Constancia de extravío',
};
const NOMBRES_TRAMITE = Object.values(NOMBRE_OFICIAL).join(', ');

const TRAMITES_CON_VIGENCIA = [18, 43, 44];
const TRAMITE_VERIFICACION = 17;

const ESTADOS = [
  [1, 'AGS', 'AGUASCALIENTES'], [2, 'BC', 'BAJA CALIFORNIA'], [3, 'BCS', 'BAJA CALIFORNIA SUR'],
  [4, 'CAMP', 'CAMPECHE'], [5, 'COAH', 'COAHUILA'], [6, 'COL', 'COLIMA'], [7, 'CHIS', 'CHIAPAS'],
  [8, 'CHIH', 'CHIHUAHUA'], [9, 'CDMX', 'CIUDAD DE MEXICO'], [10, 'DGO', 'DURANGO'],
  [11, 'GTO', 'GUANAJUATO'], [12, 'GRO', 'GUERRERO'], [13, 'HGO', 'HIDALGO'], [14, 'JAL', 'JALISCO'],
  [15, 'EDOMEX', 'ESTADO DE MEXICO'], [16, 'MICH', 'MICHOACAN'], [17, 'MOR', 'MORELOS'],
  [18, 'NAY', 'NAYARIT'], [19, 'NL', 'NUEVO LEON'], [20, 'OAX', 'OAXACA'], [21, 'PUE', 'PUEBLA'],
  [22, 'QRO', 'QUERETARO'], [23, 'QROO', 'QUINTANA ROO'], [24, 'SLP', 'SAN LUIS POTOSI'],
  [25, 'SIN', 'SINALOA'], [26, 'SON', 'SONORA'], [27, 'TAB', 'TABASCO'], [28, 'TAMPS', 'TAMAULIPAS'],
  [29, 'TLAX', 'TLAXCALA'], [30, 'VER', 'VERACRUZ'], [31, 'YUC', 'YUCATAN'], [32, 'ZAC', 'ZACATECAS'],
];
const ESTADO_ALIAS = { 'EDO MEX': 15, 'EDO DE MEX': 15, MEXICO: 15, 'ESTADO MEXICO': 15, 'DF': 9, 'CIUDAD DE MEX': 9, 'COAHUILA DE ZARAGOZA': 5 };

const VEHICULOS = {
  AUTO: 1, AUTOMOVIL: 1, CARRO: 1, COCHE: 1, AUTOMOVILES: 1,
  MOTO: 2, MOTOCICLETA: 2,
  CARGA: 3, CAMION: 3,
  HIBRI: 4, HIBRIDO: 4,
  REMOL: 5, REMOLQUE: 5,
  DISCA: 6, DISCAPACIDAD: 6,
  CLASI: 7, CLASICO: 7,
  'AUTO/MOTO': 8, 'AUTO Y MOTO': 8, 'AUTOMOVIL Y MOTOCICLETA': 8,
  ELEC: 9, ELECTRICO: 9,
};

const SERVICIOS = { VIP: 1, XP: 2, CL: 3 };

// Año del vehículo → id de cat_modelo (el id NO es el año)
const MODELOS = { 1900: 1 };
for (let anio = 1950; anio <= 2029; anio++) MODELOS[anio] = anio - 1948; // 1950→2 … 2029→81

const buscarEstado = (valor) => {
  const v = norm(valor);
  if (ESTADO_ALIAS[v]) return ESTADO_ALIAS[v];
  const fila = ESTADOS.find(([, ab, nombre]) => v === ab || v === nombre);
  return fila ? fila[0] : null;
};

const buscarVigencia = (valor) => {
  const v = norm(valor);
  if (v === '') return null;
  if (v.includes('PERMANENTE')) return 99;
  const n = parseInt(v.replace(/\D/g, ''), 10);
  return [1, 2, 3, 4].includes(n) ? n : null;
};

const buscarModelo = (valor) => {
  const anio = parseInt(String(valor ?? '').replace(/\D/g, ''), 10);
  if (!anio) return { anio: null, id: null };
  if (anio < 1950) return { anio, id: 1 }; // SIGEV solo tiene 1900; cae en el mismo rango
  return { anio, id: MODELOS[anio] ?? null };
};

const esVerdadero = (v) => v === true || ['TRUE', 'SI', '1', 'VOLUNTARIA'].includes(norm(v));

// ---------------------------------------------------------------------------
const faltan = [];
const idTramite = buscarTramite(entrada.tramite);
const idEntidad = buscarEstado(entrada.estado);
const idVehiculo = VEHICULOS[norm(entrada.vehiculo)];
const idServicio = SERVICIOS[norm(entrada.servicio)];

if (!idTramite) faltan.push(`trámite (no reconozco "${entrada.tramite ?? ''}"; usa uno de: ${NOMBRES_TRAMITE})`);
if (!idEntidad) faltan.push(`estado (no reconozco "${entrada.estado ?? ''}")`);
if (!idVehiculo) faltan.push(`tipo de vehículo (no reconozco "${entrada.vehiculo ?? ''}")`);
// El servicio es opcional: si el cliente no lo dijo, "Respuesta para el agente" consulta VIP, XP y CL.
const servicioIndicado = Boolean(idServicio);
if (!servicioIndicado && norm(entrada.servicio)) faltan.push(`servicio VIP, XP o CL (no reconozco "${entrada.servicio}")`);

const body = { id_tramite: idTramite, id_tipovehiculo: idVehiculo, id_entidad: idEntidad, id_tiposervicio: idServicio || 1 };
// Valores "id-ALIAS" con los que SIGEV crea la cotización (cat_tramite.tramite_alias, cat_tipovehiculo,
// cat_entidad.entidad_abreviatura). El servicio lo agrega "Respuesta para el agente" (puede cambiar).
const ALIAS_TRAMITE = {
  3: 'VOE', 4: 'BYA', 5: 'REE', 6: 'BAJA', 7: 'ALTA', 8: 'NVO', 9: 'RENOV', 10: 'CAMPRO', 11: 'REPTAR',
  12: 'SITCRIT', 13: 'ACLARACIÓN', 14: 'CRC', 15: 'RPV', 16: 'INVEPL', 17: 'VERI', 18: 'LICEN', 19: 'ANTRA',
  20: 'PERMI', 21: 'DESBLOQ', 22: 'CONCLU', 23: 'REFAC', 24: 'FACO', 25: 'ACTA', 26: 'CERTIPG', 27: 'VENTA',
  29: 'EXT', 30: 'REPLICEN', 31: 'LINEA', 33: 'BORRON', 34: 'ACTUALIZACION', 35: 'ACTIVACION',
  38: 'PERMICARGA', 40: 'REIMP', 42: 'CONSTANCIA', 43: 'LICENMNR', 44: 'LICENSC', 45: 'MUNDIAL', 46: 'CONSTANCIA EXT',
};
const ALIAS_VEHICULO = { 1: 'AUTO', 2: 'MOTO', 3: 'CARGA', 4: 'HIBRI', 5: 'REMOL', 6: 'DISCA', 7: 'CLASI', 8: 'AUTO/MOTO', 9: 'ELEC' };
const conAlias = (id, alias) => (id && alias ? `${id}-${alias}` : null);

const resumen = {
  tramite: entrada.tramite, id_tramite: idTramite, nombre_tramite: NOMBRE_OFICIAL[idTramite] ?? null,
  estado: entrada.estado, vehiculo: entrada.vehiculo,
  servicio: servicioIndicado ? entrada.servicio : 'sin indicar', servicioIndicado,
  sigev: {
    tipo_tramite: conAlias(idTramite, ALIAS_TRAMITE[idTramite]),
    tipo_vehiculo: conAlias(idVehiculo, ALIAS_VEHICULO[idVehiculo]),
    entidad: conAlias(idEntidad, ESTADOS.find(([id]) => id === idEntidad)?.[1]),
  },
};

if (TRAMITES_CON_VIGENCIA.includes(idTramite)) {
  const idVigencia = buscarVigencia(entrada.vigencia);
  if (!idVigencia) faltan.push('vigencia de la licencia (1, 2, 3, 4 años o permanente)');
  body.id_vigencia = idVigencia;
  resumen.vigencia = entrada.vigencia;
}

if (idTramite === TRAMITE_VERIFICACION) {
  const modelo = buscarModelo(entrada.anio);
  if (!modelo.anio) faltan.push('año del vehículo');
  else if (!modelo.id) faltan.push(`año válido del vehículo (${modelo.anio} no está en el catálogo)`);
  body.id_modelo = modelo.id;
  body.voluntaria = esVerdadero(entrada.voluntaria);
  resumen.anio = modelo.anio;
  resumen.sigev.modelo = conAlias(modelo.id, modelo.anio);
  resumen.voluntaria = body.voluntaria;
}

if (faltan.length) {
  return [{ json: {
    ok: false,
    encontrado: false,
    ...resumen,
    mensaje: idTramite
      ? `No puedo cotizar todavía. Falta o no es válido: ${faltan.join('; ')}. Pregúntale al cliente solo el primer dato que falta. No des ningún precio.`
      // Trámite no reconocido: que reintente con el nombre oficial, nunca con otro trámite "parecido"
      : `No reconozco el trámite "${entrada.tramite ?? ''}". Vuelve a llamar a cotizar_tramite con el nombre oficial que corresponda a lo que pidió el cliente, exactamente como aparece en esta lista: ${NOMBRES_TRAMITE}. NO uses otro trámite distinto ni parecido (por ejemplo, "vehículo de otra entidad" NO es "alta de placas"). Si ninguno corresponde, pregúntale al cliente qué trámite necesita. No digas que no tienes el dato y no des ningún precio.`,
  } }];
}

return [{ json: { ok: true, sigevUrl: SIGEV_URL, body, resumen } }];
