// Código del nodo "Traducir a IDs" del sub-workflow cotizar_tramite (n8n).
// Convierte lo que manda el agente (nombres legibles) en los IDs que pide SIGEV /api/getCosto.
// Catálogos tomados de SIGEV (cat_tramite, cat_entidad, cat_tipovehiculo, cat_tiposervicio,
// cat_vigencia, cat_modelo). Si SIGEV agrega trámites o estados, hay que agregarlos aquí.

const SIGEV_URL = 'https://TU-SIGEV.com'; // ← URL de SIGEV, sin "/" al final

const entrada = $input.first().json;

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
};
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
const idTramite = TRAMITES[norm(entrada.tramite)];
const idEntidad = buscarEstado(entrada.estado);
const idVehiculo = VEHICULOS[norm(entrada.vehiculo)];
const idServicio = SERVICIOS[norm(entrada.servicio)];

if (!idTramite) faltan.push(`trámite (no reconozco "${entrada.tramite ?? ''}")`);
if (!idEntidad) faltan.push(`estado (no reconozco "${entrada.estado ?? ''}")`);
if (!idVehiculo) faltan.push(`tipo de vehículo (no reconozco "${entrada.vehiculo ?? ''}")`);
if (!idServicio) faltan.push(`servicio VIP, XP o CL (no reconozco "${entrada.servicio ?? ''}")`);

const body = { id_tramite: idTramite, id_tipovehiculo: idVehiculo, id_entidad: idEntidad, id_tiposervicio: idServicio };
const resumen = {
  tramite: entrada.tramite, estado: entrada.estado, vehiculo: entrada.vehiculo, servicio: entrada.servicio,
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
  resumen.voluntaria = body.voluntaria;
}

if (faltan.length) {
  return [{ json: {
    ok: false,
    encontrado: false,
    ...resumen,
    mensaje: `No puedo cotizar todavía. Falta o no es válido: ${faltan.join('; ')}. Pregúntale al cliente solo el primer dato que falta. No des ningún precio.`,
  } }];
}

return [{ json: { ok: true, sigevUrl: SIGEV_URL, body, resumen } }];
