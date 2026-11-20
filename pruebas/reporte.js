// Reporte de pruebas: HTML (se abre en el navegador) + CSV en pruebas/resultados/.
//
// resultados: [{ tipo, caso, ok, esperado?, obtenido?, detalle?, conversacion?: [{ quien, texto }], revisiones?: [{ que, ok }] }]

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function guardarReporte({ nombre, titulo, subtitulo = '', resultados, abrir = true }) {
  const dir = path.join(__dirname, 'resultados');
  fs.mkdirSync(dir, { recursive: true });
  const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const base = path.join(dir, `${nombre}-${sello}`);

  // CSV (abre en Excel)
  const csv = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\s+/g, ' ')}"`;
  fs.writeFileSync(`${base}.csv`, '﻿' + ['resultado,tipo,caso,esperado,obtenido,detalle']
    .concat(resultados.map((r) => [r.ok ? 'PASÓ' : 'FALLÓ', r.tipo, r.caso, r.esperado, r.obtenido, r.detalle].map(csv).join(',')))
    .join('\n'));

  // HTML
  const total = resultados.length;
  const pasados = resultados.filter((r) => r.ok).length;
  const fallados = total - pasados;
  const pct = total ? Math.round((pasados * 100) / total) : 0;
  const tipos = [...new Set(resultados.map((r) => r.tipo))];
  const porTipo = tipos.map((t) => {
    const rs = resultados.filter((r) => r.tipo === t);
    return { t, total: rs.length, ok: rs.filter((r) => r.ok).length };
  });

  const fila = (r) => {
    const conversacion = r.conversacion?.length
      ? `<details><summary>Ver conversación</summary><div class="chat">${r.conversacion.map((m) => `<div class="msg ${m.quien === 'cliente' ? 'cli' : 'san'}"><b>${m.quien === 'cliente' ? 'Cliente' : 'Sandra'}</b>${esc(m.texto)}</div>`).join('')}</div></details>`
      : '';
    const revisiones = r.revisiones?.length
      ? `<ul class="rev">${r.revisiones.map((v) => `<li class="${v.ok ? 'ok' : 'mal'}">${v.ok ? '✔' : '✘'} ${esc(v.que)}</li>`).join('')}</ul>`
      : '';
    return `<tr class="${r.ok ? 'paso' : 'fallo'}" data-texto="${esc(`${r.tipo} ${r.caso} ${r.detalle ?? ''}`.toLowerCase())}">
      <td><span class="chip ${r.ok ? 'ok' : 'mal'}">${r.ok ? 'Pasó' : 'Falló'}</span></td>
      <td>${esc(r.tipo)}</td>
      <td class="caso">${esc(r.caso)}${revisiones}${conversacion}</td>
      <td>${esc(r.esperado)}</td>
      <td>${esc(r.obtenido)}</td>
      <td class="det">${esc(r.detalle)}</td></tr>`;
  };

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<style>
  :root { --fondo:#f6f7f9; --tarjeta:#fff; --texto:#1c1f24; --suave:#667085; --borde:#e4e7ec; --ok:#12805c; --ok-f:#e6f6ef; --mal:#c4320a; --mal-f:#fdece7; --acento:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --fondo:#0f1115; --tarjeta:#171a21; --texto:#e8eaed; --suave:#9aa3af; --borde:#2a2f38; --ok:#4ade80; --ok-f:#12291d; --mal:#f87171; --mal-f:#2d1515; --acento:#60a5fa; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; background:var(--fondo); color:var(--texto); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1280px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } .sub { color: var(--suave); margin: 0 0 20px; }
  .tarjetas { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-bottom:16px; }
  .t { background:var(--tarjeta); border:1px solid var(--borde); border-radius:12px; padding:14px 16px; }
  .t .n { font-size:26px; font-weight:700; } .t .l { color:var(--suave); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .t.ok .n { color:var(--ok); } .t.mal .n { color:var(--mal); }
  .barra { height:8px; border-radius:99px; background:var(--mal-f); overflow:hidden; margin: 6px 0 20px; } .barra div { height:100%; background:var(--ok); }
  .tipos { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; }
  .tipo { background:var(--tarjeta); border:1px solid var(--borde); border-radius:99px; padding:4px 12px; font-size:13px; }
  .tipo b.ok { color:var(--ok); } .tipo b.mal { color:var(--mal); }
  .controles { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
  button { font:inherit; border:1px solid var(--borde); background:var(--tarjeta); color:var(--texto); padding:6px 14px; border-radius:8px; cursor:pointer; }
  button.activo { background:var(--acento); border-color:var(--acento); color:#fff; }
  input[type=search] { font:inherit; flex:1; min-width:200px; padding:6px 12px; border-radius:8px; border:1px solid var(--borde); background:var(--tarjeta); color:var(--texto); }
  .tabla { overflow-x:auto; background:var(--tarjeta); border:1px solid var(--borde); border-radius:12px; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--borde); vertical-align:top; }
  th { font-size:12px; color:var(--suave); text-transform:uppercase; letter-spacing:.04em; position:sticky; top:0; background:var(--tarjeta); }
  tr.fallo { background: color-mix(in srgb, var(--mal-f) 55%, transparent); }
  .chip { display:inline-block; padding:2px 8px; border-radius:99px; font-size:12px; font-weight:600; white-space:nowrap; }
  .chip.ok { background:var(--ok-f); color:var(--ok); } .chip.mal { background:var(--mal-f); color:var(--mal); }
  .caso { min-width: 260px; } .det { color:var(--suave); max-width: 420px; }
  .rev { margin:6px 0 0; padding-left:0; list-style:none; font-size:13px; } .rev .ok { color:var(--ok); } .rev .mal { color:var(--mal); }
  details { margin-top:6px; } summary { cursor:pointer; color:var(--acento); }
  .chat { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
  .msg { padding:6px 10px; border-radius:10px; white-space:pre-wrap; max-width: 640px; } .msg b { display:block; font-size:11px; color:var(--suave); }
  .msg.cli { align-self:flex-end; background: color-mix(in srgb, var(--acento) 15%, transparent); } .msg.san { background: var(--fondo); }
  .oculto { display:none; }
</style></head>
<body><main>
  <h1>${esc(titulo)}</h1>
  <p class="sub">${esc(subtitulo)} · ${new Date().toLocaleString('es-MX')}</p>
  <div class="tarjetas">
    <div class="t"><div class="l">Pruebas</div><div class="n">${total}</div></div>
    <div class="t ok"><div class="l">Pasaron</div><div class="n">${pasados}</div></div>
    <div class="t mal"><div class="l">Fallaron</div><div class="n">${fallados}</div></div>
    <div class="t"><div class="l">Éxito</div><div class="n">${pct}%</div></div>
  </div>
  <div class="barra" title="${pct}% pasaron"><div style="width:${pct}%"></div></div>
  <div class="tipos">${porTipo.map((x) => `<span class="tipo">${esc(x.t)}: <b class="${x.ok === x.total ? 'ok' : 'mal'}">${x.ok}/${x.total}</b></span>`).join('')}</div>
  <div class="controles">
    <button data-filtro="todos">Todos (${total})</button>
    <button data-filtro="fallo" class="activo">Fallaron (${fallados})</button>
    <button data-filtro="paso">Pasaron (${pasados})</button>
    <input type="search" id="buscar" placeholder="Buscar trámite, estado, motivo…">
  </div>
  <div class="tabla"><table>
    <thead><tr><th>Resultado</th><th>Tipo</th><th>Caso</th><th>Esperado</th><th>Obtenido</th><th>Detalle</th></tr></thead>
    <tbody>${[...resultados].sort((a, b) => Number(a.ok) - Number(b.ok)).map(fila).join('')}</tbody>
  </table></div>
</main>
<script>
  let filtro = ${fallados ? "'fallo'" : "'todos'"};
  const botones = document.querySelectorAll('[data-filtro]');
  const buscar = document.getElementById('buscar');
  function aplicar() {
    const q = buscar.value.trim().toLowerCase();
    for (const tr of document.querySelectorAll('tbody tr')) {
      const porFiltro = filtro === 'todos' || tr.classList.contains(filtro);
      tr.classList.toggle('oculto', !(porFiltro && (!q || tr.dataset.texto.includes(q))));
    }
    botones.forEach((b) => b.classList.toggle('activo', b.dataset.filtro === filtro));
  }
  botones.forEach((b) => b.addEventListener('click', () => { filtro = b.dataset.filtro; aplicar(); }));
  buscar.addEventListener('input', aplicar);
  aplicar();
</script>
</body></html>`;
  fs.writeFileSync(`${base}.html`, html);

  if (abrir && !process.env.PRUEBAS_OCULTO) {
    const cmd = process.platform === 'win32' ? `start "" "${base}.html"` : process.platform === 'darwin' ? `open "${base}.html"` : `xdg-open "${base}.html"`;
    exec(cmd, () => {});
  }
  return { html: `${base}.html`, csv: `${base}.csv` };
}

module.exports = { guardarReporte };
