// public/js/cozinha.js — Kitchen Display System
import {
  $, $$, api, auth, esc, toast, timeAgo, TYPE_ICON, TYPE_LABEL,
} from './api.js';

const state = { orders: [], timer: null, es: null, sound: true, clock: null, audioCtx: null };

init();

async function init() {
  $('#kdsLoginForm').addEventListener('submit', login);
  $('#kdsLogout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', auth: true }); } catch { /* ignore */ }
    auth.clear();
    location.reload();
  });
  $('#kdsSound').addEventListener('click', toggleSound);
  $('#kdsFull').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  window.addEventListener('sf:unauthorized', () => showLogin());

  setInterval(() => {
    const now = new Date();
    const el = document.getElementById('kdsClock');
    if (el) el.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    updateTimes();
  }, 1000);

  await refreshSoundState();

  if (!auth.token) return showLogin();
  try {
    const { user } = await api('/api/auth/me', { auth: true });
    if (!['admin', 'manager', 'cashier', 'kitchen'].includes(user.role)) return showLogin();
    start();
  } catch {
    auth.clear();
    showLogin();
  }
}

function showLogin() {
  $('#kdsLogin').classList.remove('hidden');
  $('#kdsApp').classList.add('hidden');
  document.getElementById('kEmail')?.focus();
}

async function login(e) {
  e.preventDefault();
  const err = $('#kError');
  err.textContent = '';
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: $('#kEmail').value, password: $('#kPass').value },
    });
    if (!['admin', 'manager', 'cashier', 'kitchen'].includes(res.user.role)) {
      err.textContent = 'Esta conta não tem acesso à cozinha.';
      return;
    }
    auth.set(res.token, res.user);
    start();
  } catch (ex) {
    err.textContent = ex.message;
  }
}

function start() {
  $('#kdsLogin').classList.add('hidden');
  $('#kdsApp').classList.remove('hidden');
  api('/api/store').then(({ store }) => {
    $('#kdsStore').textContent = `Cozinha · ${store.store_name}`;
    document.title = `Cozinha · ${store.store_name}`;
  }).catch(() => {});
  load();
  state.timer = setInterval(load, 10000);
  connectEvents();
}

async function load() {
  try {
    const { orders } = await api('/api/admin/orders', {
      auth: true,
      params: { status: 'pending,confirmed,preparing,ready', limit: 60 },
    });
    const known = new Set(state.orders.map((o) => o.id));
    const fresh = orders.filter((o) => !known.has(o.id));
    state.orders = orders;
    render();
    if (state.loaded && fresh.length) {
      beep();
      toast(`${fresh.length} pedido novo na cozinha`, 'info');
    }
    state.loaded = true;
  } catch (err) {
    if (err.status === 401) showLogin();
  }
}

function columnOf(order) {
  if (order.status === 'pending' || order.status === 'confirmed') return 'new';
  if (order.status === 'preparing') return 'preparing';
  return 'ready';
}

function render() {
  const cols = { new: [], preparing: [], ready: [] };
  for (const o of state.orders) cols[columnOf(o)].push(o);

  for (const [key, list] of Object.entries(cols)) {
    $(`#count-${key}`).textContent = list.length;
    const host = $(`#list-${key}`);
    host.innerHTML = list.length
      ? list.map(ticket).join('')
      : `<div class="kds-empty">Nada aqui agora.</div>`;
  }

  $('#kdsQueue').textContent = `${state.orders.length} pedido${state.orders.length === 1 ? '' : 's'} na fila`;
  updateTimes();
  bindActions();
}

function ticket(order) {
  const items = order.items
    .map(
      (i) => `<div class="kds-item"><b>${i.qty}×</b><span>${esc(i.name)}</span></div>` +
        (i.notes ? `<div class="kds-note">↳ ${esc(i.notes)}</div>` : '')
    )
    .join('');

  const actions =
    order.status === 'pending' || order.status === 'confirmed'
      ? `<button class="btn btn-primary" data-adv="${order.id}" data-to="preparing">▶ Iniciar preparo</button>`
      : order.status === 'preparing'
        ? `<button class="btn btn-primary" data-adv="${order.id}" data-to="ready">✓ Marcar pronto</button>`
        : order.type === 'delivery'
          ? `<button class="btn" data-adv="${order.id}" data-to="out_for_delivery">🛵 Saiu para entrega</button>`
          : `<button class="btn" data-adv="${order.id}" data-to="completed">🏁 Entregar / concluir</button>`;

  return `
    <article class="kds-ticket" data-id="${order.id}" data-time="${order.created_at}">
      <div class="kds-ticket-head">
        <div>
          <div class="kds-code">${esc(order.code)}</div>
          <div class="kds-meta mt-1">
            <span>${TYPE_ICON[order.type]} ${TYPE_LABEL[order.type]}</span>
            ${order.table_name ? `<span>· ${esc(order.table_name)}</span>` : ''}
            <span>· ${esc(order.customer_name)}</span>
          </div>
        </div>
        <div class="kds-time" data-elapsed>⏱ ${timeAgo(order.created_at)}</div>
      </div>
      <div class="kds-items">${items}</div>
      ${order.notes ? `<div class="kds-obs">📝 ${esc(order.notes)}</div>` : ''}
      <div class="kds-actions">${actions}</div>
    </article>`;
}

function bindActions() {
  $$('[data-adv]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.adv);
      btn.disabled = true;
      try {
        await api(`/api/admin/orders/${id}/status`, {
          method: 'PATCH', auth: true, body: { status: btn.dataset.to },
        });
        beep(660);
        await load();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    })
  );
}

function updateTimes() {
  $$('.kds-ticket').forEach((card) => {
    const el = card.querySelector('[data-elapsed]');
    if (!el) return;
    const created = card.dataset.time;
    const minutes = (Date.now() - new Date(created).getTime()) / 60000;
    el.textContent = `⏱ ${timeAgo(created)}`;
    el.classList.toggle('warn', minutes >= 15 && minutes < 25);
    el.classList.toggle('late', minutes >= 25);
    card.classList.toggle('urgent', minutes >= 30);
  });
}

function connectEvents() {
  if (state.es) state.es.close();
  state.es = new EventSource(`/api/admin/events?token=${encodeURIComponent(auth.token)}`);
  state.es.addEventListener('order:new', () => {
    load();
    beep();
  });
  state.es.addEventListener('order:update', () => load());
  state.es.onerror = () => {
    $('#kdsLive').classList.add('off');
    setTimeout(() => $('#kdsLive')?.classList.remove('off'), 4000);
  };
}

// som de notificação (WebAudio, sem arquivos)
async function refreshSoundState() {
  state.sound = localStorage.getItem('sf_kds_sound') !== 'off';
  paintSound();
}
function toggleSound() {
  state.sound = !state.sound;
  localStorage.setItem('sf_kds_sound', state.sound ? 'on' : 'off');
  if (state.sound) beep();
  paintSound();
}
function paintSound() {
  const btn = document.getElementById('kdsSound');
  if (btn) btn.textContent = state.sound ? '🔔 Som ligado' : '🔕 Som desligado';
}
function beep(freq = 880) {
  if (!state.sound) return;
  try {
    state.audioCtx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.42);
  } catch { /* ignora */ }
}
