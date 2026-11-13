(() => {
  const params = new URLSearchParams(location.search);

  // Identificador del cliente: ?cliente=ID en la URL, o uno aleatorio guardado en este navegador
  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function getClientId() {
    const fromUrl = params.get('cliente');
    if (fromUrl) return fromUrl;
    try {
      let id = localStorage.getItem('chatClientId');
      if (!id) {
        id = randomId();
        localStorage.setItem('chatClientId', id);
      }
      return id;
    } catch {
      return randomId();
    }
  }

  // Link de referido: /{código de 8 caracteres}, p. ej. /IG07x4Kp (distingue mayúsculas)
  const code = location.pathname.split('/').find(Boolean) || '';

  const socket = io({
    auth: { clientId: getClientId(), name: params.get('nombre') || undefined, code },
  });

  const $ = (sel) => document.querySelector(sel);
  const messagesEl = $('#messages');
  const composer = $('#composer');
  const textInput = $('#textInput');
  const emojiPanel = $('#emojiPanel');

  // Texto del campo de mensaje según el tema (lo fija index.html a partir del link)
  const PLACEHOLDERS = { instagram: 'Mensaje...', tiktok: 'Enviar mensaje...', facebook: 'Aa' };
  textInput.placeholder = PLACEHOLDERS[document.documentElement.dataset.theme] || 'Mensaje...';

  let me = null;
  let contact = null;
  let messages = [];
  let contactTyping = false;

  const GROUP_GAP = 60 * 1000;       // mensajes a menos de 1 min se agrupan
  const SEPARATOR_GAP = 30 * 60 * 1000; // separador de fecha tras 30 min

  // ---------- Utilidades ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Texto con las URLs (http/https) convertidas en links. Se arma con nodos, nunca con innerHTML.
  const URL_RE = /https?:\/\/[^\s<>"']+/g;
  const TRAILING_PUNCT_RE = /[.,;:!?)\]}¡¿]+$/; // "…id=123." → el punto no es parte del link
  function linkify(node, text) {
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      let url = match[0];
      const trailing = url.match(TRAILING_PUNCT_RE);
      if (trailing) url = url.slice(0, -trailing[0].length);
      if (match.index > last) node.append(text.slice(last, match.index));
      const a = el('a', 'bubble-link', url);
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      node.append(a);
      last = match.index + url.length;
    }
    if (last < text.length) node.append(text.slice(last));
    return node;
  }

  function fmtTime(d) {
    let h = d.getHours();
    const ampm = h < 12 ? 'a.m.' : 'p.m.';
    h = h % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
  }

  function fmtSeparator(d) {
    const now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(d)) / 864e5);
    let day;
    if (days === 0) day = 'Hoy';
    else if (days === 1) day = 'Ayer';
    else if (days < 7) {
      day = d.toLocaleDateString('es', { weekday: 'long' });
      day = day.charAt(0).toUpperCase() + day.slice(1);
    } else {
      day = d.toLocaleDateString('es', {
        day: 'numeric',
        month: 'short',
        year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      });
    }
    return `${day} a las ${fmtTime(d)}`;
  }

  function statusText() {
    if (contactTyping) return 'Escribiendo...';
    if (contact.online) return 'Activo ahora';
    if (!contact.last_seen) return 'Activo recientemente';
    const mins = (Date.now() - new Date(contact.last_seen)) / 60000;
    if (mins < 1) return 'Activo hace un momento';
    if (mins < 60) return `Activo hace ${Math.floor(mins)} min`;
    if (mins < 24 * 60) return `Activo hace ${Math.floor(mins / 60)} h`;
    return 'Activo recientemente';
  }

  function systemText(m) {
    if (m.content === 'accepted') {
      return `Iniciaste una conversación con ${contact.name}`;
    }
    return m.content;
  }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- Render ----------
  function renderHeader() {
    $('#contactAvatar').src = contact.avatar;
    $('#contactName').textContent = contact.name;
    $('#verifiedBadge').hidden = !contact.verified;
    $('#contactStatus').textContent = statusText();
    document.title = `${contact.name} • Chat`;
  }

  function avatarCell(show) {
    if (!show) return el('div', 'row-avatar ghost');
    const img = el('img', 'row-avatar');
    img.src = contact.avatar;
    img.alt = '';
    return img;
  }

  function renderMessages(forceScroll = false) {
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    const frag = document.createDocumentFragment();

    messages.forEach((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const time = new Date(m.created_at);

      if (!prev || time - new Date(prev.created_at) > SEPARATOR_GAP) {
        frag.append(el('div', 'separator', fmtSeparator(time)));
      }
      if (m.type === 'system') {
        frag.append(el('div', 'system', systemText(m)));
        return;
      }

      const mine = m.sender === 'client';
      const last =
        !next ||
        next.type === 'system' ||
        next.sender !== m.sender ||
        new Date(next.created_at) - time > GROUP_GAP;

      const row = el('div', `row ${mine ? 'mine' : 'theirs'}${last ? ' last' : ''}`);
      if (!mine) row.append(avatarCell(last));

      let bubble;
      if (m.type === 'image') {
        bubble = el('button', 'photo');
        bubble.type = 'button';
        bubble.setAttribute('aria-label', 'Abrir foto');
        const img = el('img');
        img.src = m.content;
        img.alt = 'Foto';
        img.loading = 'lazy';
        // al terminar de cargar, mantener el scroll abajo si ya lo estaba
        img.addEventListener('load', () => {
          if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < img.height + 160) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        });
        bubble.append(img);
        bubble.addEventListener('click', () => openLightbox(m.content));
      } else {
        bubble = linkify(el('div', 'bubble'), m.content);
      }
      bubble.title = fmtTime(time);
      row.append(bubble);
      frag.append(row);
    });

    if (contactTyping) {
      const row = el('div', 'row theirs last');
      row.append(avatarCell(true));
      const dots = el('div', 'bubble typing');
      dots.append(el('span'), el('span'), el('span'));
      row.append(dots);
      frag.append(row);
    }

    messagesEl.replaceChildren(frag);
    if (forceScroll || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- Socket ----------
  socket.on('init', (data) => {
    me = data.me;
    contact = data.contact;
    messages = data.messages;
    contactTyping = false;
    renderHeader();
    renderMessages(true);
  });

  socket.on('message', (m) => {
    if (!me || messages.some((x) => x.id === m.id)) return;
    messages.push(m);
    if (m.sender === 'influencer') {
      contactTyping = false;
      clearTimeout(typingTimeout);
    }
    renderHeader();
    renderMessages(m.sender === 'client');
  });

  socket.on('presence', (p) => {
    if (!contact) return;
    if (p.lastSeen) contact.last_seen = p.lastSeen;
    renderHeader();
  });

  // "Escribiendo..." de Sandra: lo activa el servidor 1 s después de cada mensaje del cliente
  // (o n8n con POST /api/typing). Se quita al llegar la respuesta, o a los 2 min si nunca llega.
  let typingTimeout;
  socket.on('typing', (t) => {
    if (!contact) return;
    contactTyping = t.typing;
    clearTimeout(typingTimeout);
    if (t.typing) {
      typingTimeout = setTimeout(() => {
        contactTyping = false;
        renderHeader();
        renderMessages();
      }, 2 * 60 * 1000);
    }
    renderHeader();
    renderMessages();
  });

  socket.on('connect_error', (err) => {
    // Link inválido o influencer inactivo: no hay chat que mostrar
    if (!contact) {
      $('#contactName').textContent = 'Chat no disponible';
      $('#contactStatus').textContent = '';
      $('#contactAvatar').hidden = true;
      composer.hidden = true;
      messagesEl.replaceChildren(el('div', 'system', err.message));
    } else {
      toast(err.message);
    }
  });
  socket.on('fatal', (msg) => toast(msg));

  // refresca "Activo hace X min"
  setInterval(() => contact && renderHeader(), 30000);

  // ---------- Enviar texto ----------
  function updateComposerState() {
    const hasText = textInput.value.trim().length > 0;
    composer.classList.toggle('has-text', hasText);
    $('#sendBtn').disabled = !hasText;
  }

  textInput.addEventListener('input', updateComposerState);

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const content = textInput.value.trim();
    if (!content) return;
    socket.emit('message', { type: 'text', content }, (res) => {
      if (!res || !res.ok) {
        toast((res && res.error) || 'No se pudo enviar');
        textInput.value = content;
        updateComposerState();
      }
    });
    textInput.value = '';
    updateComposerState();
    emojiPanel.hidden = true;
    textInput.focus();
  });

  // ---------- Enviar fotos ----------
  async function sendPhoto(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('La imagen supera 5 MB');
    const form = new FormData();
    form.append('photo', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al subir la imagen');
      socket.emit('message', { type: 'image', content: data.url }, (r) => {
        if (!r || !r.ok) toast((r && r.error) || 'No se pudo enviar la foto');
      });
    } catch (err) {
      toast(err.message);
    }
  }

  const photoInput = $('#photoInput');
  photoInput.addEventListener('change', () => {
    void sendPhoto(photoInput.files[0]);
    photoInput.value = '';
  });

  // ---------- Visor ----------
  const lightbox = $('#lightbox');
  function openLightbox(url) {
    $('#lightboxImg').src = url;
    lightbox.hidden = false;
  }
  lightbox.addEventListener('click', (e) => {
    if (e.target !== $('#lightboxImg')) lightbox.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      lightbox.hidden = true;
      emojiPanel.hidden = true;
    }
  });

  // ---------- Emojis ----------
  const EMOJIS = (
    '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😗 😚 😋 😛 😜 🤪 😝 🤗 🤭 ' +
    '🤔 🤨 😐 😑 😶 🙄 😏 😬 😌 😔 😪 😴 😷 🥵 🥶 🥴 😵 🤯 😎 🥳 😕 😟 🙁 😮 ' +
    '😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 😤 😡 😠 🤬 😈 💀 ' +
    '👍 👎 👏 🙌 🙏 💪 👋 🤝 ✌️ 🤞 👌 🤙 👀 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💖 ' +
    '💯 🔥 ✨ ⭐ 🎉 🎂 🌹 🌸 ☀️ 🌙 ☕ 🍕 🍔 🍓 🍷 🎶 📸 💋'
  ).split(' ');

  for (const e of EMOJIS) {
    const b = el('button', null, e);
    b.type = 'button';
    b.addEventListener('click', () => insertAtCursor(e));
    emojiPanel.append(b);
  }

  function insertAtCursor(text) {
    const start = textInput.selectionStart ?? textInput.value.length;
    const end = textInput.selectionEnd ?? textInput.value.length;
    textInput.value = textInput.value.slice(0, start) + text + textInput.value.slice(end);
    const pos = start + text.length;
    textInput.focus();
    textInput.setSelectionRange(pos, pos);
    updateComposerState();
  }

  $('#emojiBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPanel.hidden = !emojiPanel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!emojiPanel.hidden && !emojiPanel.contains(e.target)) emojiPanel.hidden = true;
  });
})();
