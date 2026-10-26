// public/js/admin.js — painel da loja
import {
  $, $$, api, auth, money, esc, toast, openModal, closeModal, confirmDialog,
  fmtDateTime, timeAgo, maskPhone, onlyDigits, statusBadge, typeBadge, applyLogo, imageToDataUrl,
  STATUS_LABEL, TYPE_LABEL, TYPE_ICON, PAYMENT_LABEL, whatsappLink,
} from './api.js';

const state = {
  user: null,
  view: 'dashboard',
  settings: null,
  tables: [],
  products: [],
  categories: [],
  pos: { items: [], type: 'pos', tableId: null, payment: 'cash', coupon: '' },
  orders: [],
  orderFilter: 'active',
  orderSearch: '',
  es: null,
  timers: [],
};

const ROLE_LABEL = { admin: 'Administrador', manager: 'Gerente', cashier: 'Caixa', kitchen: 'Cozinha' };
const VIEW_META = {
  dashboard: ['Visão geral', 'Resumo do movimento de hoje'],
  orders: ['Pedidos', 'Acompanhe e atualize os pedidos em tempo real'],
  pos: ['Novo pedido', 'Registre vendas no balcão, mesa, retirada ou entrega'],
  tables: ['Mesas', 'Ocupação e comandas abertas'],
  menu: ['Cardápio', 'Produtos, preços e categorias'],
  coupons: ['Cupons', 'Descontos para vendas online'],
  reports: ['Relatórios', 'Faturamento e produtos mais vendidos'],
  team: ['Equipe', 'Usuários e permissões de acesso'],
  settings: ['Configurações', 'Dados da loja, entrega e pagamento'],
};

// ---------------------------------------------------------------- boot
init();

async function init() {
  bindLogin();
  if (auth.token) {
    try {
      const { user } = await api('/api/auth/me', { auth: true });
      state.user = user;
      await boot();
    } catch {
      auth.clear();
    }
  }
  if (!state.user) showLogin();
}

function showLogin() {
  $('#loginScreen').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
  api('/api/store').then(({ store }) => {
    $('#loginStoreName').textContent = store.store_name;
    document.getElementById('loginEmail').focus();
  }).catch(() => {});
}

function bindLogin() {
  const form = $('#loginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn');
    const err = $('#loginError');
    err.textContent = '';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Entrando...';
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: { email: $('#loginEmail').value, password: $('#loginPassword').value },
      });
      auth.set(res.token, res.user);
      state.user = res.user;
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });

  $$('.demo-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#loginEmail').value = chip.dataset.email;
      $('#loginPassword').value = chip.dataset.pass;
      $('#loginForm').requestSubmit();
    });
  });
}

async function boot() {
  $('#loginScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');

  if (!['admin', 'manager', 'cashier', 'kitchen'].includes(state.user.role)) {
    auth.clear();
    toast('Sua conta não tem acesso ao painel.', 'error');
    return showLogin();
  }

  const initials = state.user.name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
  $('#userName').textContent = state.user.name;
  $('#userAvatar').textContent = initials;
  $('#userRole').textContent = ROLE_LABEL[state.user.role] || state.user.role;

  if (!['admin', 'manager'].includes(state.user.role)) {
    $$('.side-link[data-view]').forEach((a) => {
      if (['team', 'settings', 'coupons'].includes(a.dataset.view)) a.classList.add('hidden');
    });
  }
  if (state.user.role === 'kitchen') {
    $$('.side-link[data-view]').forEach((a) => {
      if (!['orders'].includes(a.dataset.view)) a.classList.add('hidden');
    });
  }

  bindShell();
  await loadSettings();
  connectEvents();
  const initial = (location.hash || '#dashboard').slice(1);
  navigate(VIEW_META[initial] ? initial : 'dashboard');
  setInterval(loadSettings, 60000);
  setInterval(() => {
    if (state.view === 'dashboard') refreshDashboardCounters();
  }, 30000);
}

function bindShell() {
  $$('.side-link[data-view]').forEach((link) => {
    link.addEventListener('click', () => {
      navigate(link.dataset.view);
      closeSidebar();
    });
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', auth: true }); } catch { /* ignore */ }
    auth.clear();
    state.user = null;
    if (state.es) state.es.close();
    showLogin();
  });

  $('#storeToggle').addEventListener('click', async () => {
    if (!['admin', 'manager'].includes(state.user.role)) {
      return toast('Apenas gerentes podem abrir/fechar a loja.', 'error');
    }
    const next = state.settings.open !== '1';
    try {
      const { settings } = await api('/api/admin/settings', {
        method: 'PUT', auth: true, body: { open: next },
      });
      state.settings = settings;
      paintStoreState();
      toast(next ? 'Loja aberta para pedidos online 🎉' : 'Loja fechada para pedidos online.', next ? 'success' : 'info');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#menuBtn').addEventListener('click', () => {
    $('#sidebar').classList.add('open');
    $('#sideBackdrop').classList.add('show');
  });
  $('#sideBackdrop').addEventListener('click', closeSidebar);

  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (VIEW_META[v] && v !== state.view) navigate(v, { skipHash: true });
  });

  window.addEventListener('sf:unauthorized', () => {
    state.user = null;
    if (state.es) state.es.close();
    showLogin();
    toast('Sua sessão expirou. Entre novamente.', 'error');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
    if (e.key === 'F2') { e.preventDefault(); navigate('pos'); }
    if (e.key === 'F3') { e.preventDefault(); navigate('orders'); }
  });
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sideBackdrop').classList.remove('show');
}

async function loadSettings() {
  try {
    const { settings } = await api('/api/admin/settings', { auth: true });
    state.settings = settings;
    $('#sideStoreName').textContent = settings.store_name;
    $('#loginStoreName').textContent = settings.store_name;
    document.title = `${settings.store_name} · Painel`;
    applyLogo(settings.logo);
    paintStoreState();
  } catch { /* ignore */ }
}

function paintStoreState() {
  if (!state.settings) return;
  const open = state.settings.open === '1';
  $('#storeToggle').classList.toggle('closed', !open);
  $('#storeDot').style.background = open ? 'var(--green)' : 'var(--red)';
  $('#storePillText').textContent = open ? 'Loja aberta' : 'Loja fechada';
}

// ---------------------------------------------------------------- roteador
function navigate(view, { skipHash = true } = {}) {
  if (!VIEW_META[view]) view = 'dashboard';
  state.view = view;
  if (!skipHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  else if (skipHash) history.replaceState(null, '', `#${view}`);

  $$('.side-link[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $('#viewTitle').textContent = VIEW_META[view][0];
  $('#viewSub').textContent = VIEW_META[view][1];
  $('#view').innerHTML = `<div class="card"><div class="row"><span class="spinner"></span><span class="muted">Carregando...</span></div></div>`;

  state.timers.forEach(clearInterval);
  state.timers = [];

  const render = {
    dashboard: renderDashboard,
    orders: renderOrders,
    pos: renderPOS,
    tables: renderTables,
    menu: renderMenuAdmin,
    coupons: renderCoupons,
    reports: renderReports,
    team: renderTeam,
    settings: renderSettings,
  }[view];

  render?.().catch((err) => {
    console.error(err);
    $('#view').innerHTML = `<div class="alert alert-error">Erro ao carregar: ${esc(err.message)}</div>`;
  });
}

// ---------------------------------------------------------------- tempo real
function connectEvents() {
  if (state.es) state.es.close();
  state.es = new EventSource(`/api/admin/events?token=${encodeURIComponent(auth.token)}`);
  state.es.addEventListener('order:new', (e) => {
    let order;
    try { order = JSON.parse(e.data).order; } catch { return; }
    toast(`Novo pedido ${order.code} · ${money(order.total)}`, 'info', 6000);
    beep();
    if (['orders', 'dashboard', 'tables'].includes(state.view)) {
      if (state.view === 'orders') renderOrders({ silent: true });
      if (state.view === 'dashboard') renderDashboard();
      if (state.view === 'tables') renderTables();
    }
    refreshBadge();
  });
  state.es.addEventListener('order:update', () => {
    if (state.view === 'orders') renderOrders({ silent: true });
    if (state.view === 'tables') renderTables();
    if (state.view === 'dashboard') refreshDashboardCounters();
  });
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch { /* silencioso */ }
}

async function refreshBadge() {
  try {
    const { orders } = await api('/api/admin/orders', { auth: true, params: { status: 'pending', limit: 50 } });
    const badge = document.getElementById('navOrdersBadge');
    if (!badge) return;
    badge.textContent = orders.length;
    badge.classList.toggle('hidden', orders.length === 0);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- visão geral
async function renderDashboard() {
  const [{ today, openOrders, pendingOnline, tablesOccupied, tablesTotal, series, topProducts }, latest] =
    await Promise.all([
      api('/api/admin/stats', { auth: true, params: { days: 7 } }),
      api('/api/admin/orders', { auth: true, params: { limit: 6 } }),
    ]);

  const activeOrders = latest.orders.filter((o) => !['completed', 'cancelled'].includes(o.status));
  const maxRev = Math.max(...series.map((s) => s.revenue), 1);
  const todayIdx = series.length - 1;

  $('#view').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi brand">
        <div class="kpi-ico">💰</div>
        <div class="kpi-label">Faturamento hoje</div>
        <div class="kpi-value">${money(today.revenue)}</div>
        <div class="kpi-foot">${money(today.paidRevenue)} já recebido</div>
      </div>
      <div class="kpi">
        <div class="kpi-ico">🧾</div>
        <div class="kpi-label">Pedidos hoje</div>
        <div class="kpi-value">${today.orders}</div>
        <div class="kpi-foot">${today.items} itens vendidos</div>
      </div>
      <div class="kpi">
        <div class="kpi-ico">🎯</div>
        <div class="kpi-label">Ticket médio</div>
        <div class="kpi-value">${money(today.avgTicket)}</div>
        <div class="kpi-foot">${today.delivery} entregas · ${today.dinein} mesas</div>
      </div>
      <div class="kpi green">
        <div class="kpi-ico">⏱️</div>
        <div class="kpi-label">Em andamento</div>
        <div class="kpi-value" id="kpiActive">${openOrders}</div>
        <div class="kpi-foot" id="kpiPending">${pendingOnline} online aguardando</div>
      </div>
    </div>

    <div class="grid-main">
      <div class="card">
        <div class="card-head">
          <div>
            <h3 class="card-title">Faturamento dos últimos 7 dias</h3>
            <p class="muted small">Pedidos concluídos e em andamento (cancelados não entram)</p>
          </div>
          <button class="btn btn-sm btn-ghost" data-go="reports">Ver relatórios →</button>
        </div>
        <div class="chart">
          ${series
            .map(
              (d, i) => `
            <div class="chart-col">
              <div class="chart-bar-wrap">
                <div class="chart-bar ${i === todayIdx ? 'today' : ''}" style="height:${Math.max(4, (d.revenue / maxRev) * 100)}%">
                  <span class="tip">${d.label} · ${money(d.revenue)} · ${d.orders} ped.</span>
                </div>
              </div>
              <span class="chart-label">${d.label}</span>
            </div>`
            )
            .join('')}
        </div>
        <div class="legend mt-2">
          <span><i style="background:#ff6b2c"></i>Dias anteriores</span>
          <span><i style="background:#ffb03a"></i>Hoje</span>
        </div>
      </div>

      <div class="stack" style="gap:14px">
        <div class="card">
          <div class="card-head"><h3 class="card-title">Operação agora</h3></div>
          <div class="list">
            <div class="list-row">
              <span style="font-size:18px">📥</span>
              <div class="grow"><strong class="small">Pedidos online aguardando</strong><br><small class="muted tiny">Precisam de confirmação</small></div>
              <span class="badge ${pendingOnline ? 'badge-pending' : 'badge-completed'}">${pendingOnline}</span>
              <button class="btn btn-sm btn-ghost" data-go="orders">Ver</button>
            </div>
            <div class="list-row">
              <span style="font-size:18px">🍽️</span>
              <div class="grow"><strong class="small">Mesas ocupadas</strong><br><small class="muted tiny">de ${tablesTotal} mesas</small></div>
              <span class="badge ${tablesOccupied ? 'badge-preparing' : 'badge-completed'}">${tablesOccupied}</span>
              <button class="btn btn-sm btn-ghost" data-go="tables">Ver</button>
            </div>
            <div class="list-row">
              <span style="font-size:18px">👨‍🍳</span>
              <div class="grow"><strong class="small">Cozinha</strong><br><small class="muted tiny">Abrir tela de produção</small></div>
              <a class="btn btn-sm btn-ghost" href="/cozinha" target="_blank">Abrir ↗</a>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3 class="card-title">Mais vendidos (7 dias)</h3></div>
          ${
            topProducts.length
              ? `<div class="list">${topProducts
                  .map((p, i) => {
                    const max = Math.max(...topProducts.map((x) => x.qty), 1);
                    return `<div class="list-row">
                      <span class="rank ${i === 0 ? 'top' : ''}">${i + 1}</span>
                      <div class="grow">
                        <div class="between"><strong class="small">${esc(p.name)}</strong><small class="muted tiny">${p.qty}×</small></div>
                        <div class="bar-mini"><i style="width:${(p.qty / max) * 100}%"></i></div>
                      </div>
                    </div>`;
                  })
                  .join('')}</div>`
              : `<div class="empty" style="padding:24px"><span class="emoji">📉</span><small>Sem vendas no período.</small></div>`
          }
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 class="card-title">Pedidos recentes</h3>
        <button class="btn btn-sm btn-ghost" data-go="orders">Ver todos →</button>
      </div>
      ${
        activeOrders.length
          ? `<div class="orders-grid">${activeOrders.map(orderCard).join('')}</div>`
          : `<div class="empty"><span class="emoji">🍃</span><p>Nenhum pedido em andamento agora.</p>
             <button class="btn btn-soft btn-sm" data-go="pos">Criar pedido no PDV</button></div>`
      }
    </div>`;

  bindViewActions();
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.go)));
  refreshBadge();
}

async function refreshDashboardCounters() {
  const data = await api('/api/admin/stats', { auth: true }).catch(() => null);
  if (!data) return;
  const el = document.getElementById('kpiActive');
  if (el) el.textContent = data.openOrders;
  const foot = document.getElementById('kpiPending');
  if (foot) foot.textContent = `${data.pendingOnline} online aguardando`;
  refreshBadge();
}

// ---------------------------------------------------------------- pedidos
async function renderOrders({ silent = false } = {}) {
  const view = $('#view');
  const hadFocusSearch = document.activeElement?.id === 'orderSearch';
  const cursorPos = hadFocusSearch ? document.activeElement.selectionStart : null;

  const { orders } = await api('/api/admin/orders', {
    auth: true,
    params: { status: state.orderFilter, search: state.orderSearch, limit: 80 },
  });
  state.orders = orders;

  const filters = [
    ['active', 'Em andamento'],
    ['pending', 'Aguardando'],
    ['preparing', 'Em preparo'],
    ['ready', 'Prontos'],
    ['out_for_delivery', 'Em entrega'],
    ['completed', 'Concluídos'],
    ['cancelled', 'Cancelados'],
    ['all', 'Todos'],
  ];

  view.innerHTML = `
    <div class="orders-toolbar">
      <input class="input" id="orderSearch" placeholder="🔎 Código, cliente ou telefone..." value="${esc(state.orderSearch)}" />
      <div class="tabs" id="orderFilters">
        ${filters.map(([k, l]) => `<button class="tab ${state.orderFilter === k ? 'active' : ''}" data-filter="${k}">${l}</button>`).join('')}
      </div>
      <span class="live-pill ${state.es ? '' : 'off'}" style="margin-left:auto"><span class="dot"></span> tempo real</span>
      <button class="btn btn-sm" id="refreshOrders">↻ Atualizar</button>
      <button class="btn btn-sm btn-primary" data-go="pos">+ Novo pedido</button>
    </div>

    <div id="ordersList">
      ${
        orders.length
          ? `<div class="orders-grid">${orders.map(orderCard).join('')}</div>`
          : `<div class="empty"><span class="emoji">🧾</span><p>Nenhum pedido nesta categoria.</p></div>`
      }
    </div>`;

  $('#orderFilters').querySelectorAll('[data-filter]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.orderFilter = btn.dataset.filter;
      renderOrders();
    })
  );
  const search = $('#orderSearch');
  search.addEventListener('input', debounce(() => {
    state.orderSearch = search.value.trim();
    renderOrders();
  }, 350));
  $('#refreshOrders').addEventListener('click', () => renderOrders());
  $('[data-go="pos"]')?.addEventListener('click', () => navigate('pos'));
  bindViewActions({ silent });
  if (hadFocusSearch) {
    search.focus();
    try { search.setSelectionRange(cursorPos, cursorPos); } catch { /* ignore */ }
  }
  refreshBadge();
}

function orderCard(order) {
  const items = order.items || [];
  const shown = items.slice(0, 3);
  const nextAction = nextActionFor(order);
  const isNew = Date.now() - new Date(order.created_at).getTime() < 20000;

  return `
    <article class="order-card st-${order.status} ${isNew ? 'new' : ''}" data-order-id="${order.id}">
      <div class="order-head">
        <div>
          <div class="order-code">${esc(order.code)}</div>
          <div class="order-meta">
            ${typeBadge(order.type)}
            <span>🕒 ${timeAgo(order.created_at)}</span>
            ${order.table_name ? `<span>🍽️ ${esc(order.table_name)}</span>` : ''}
          </div>
        </div>
        ${statusBadge(order.status)}
      </div>

      <div class="order-items">
        <strong class="small">${esc(order.customer_name)}</strong>
        ${order.customer_phone ? `<span class="muted tiny"> · ${esc(order.customer_phone)}</span>` : ''}
        <div class="mt-1">${shown.map((i) => `${i.qty}× ${esc(i.name)}`).join('<br>')}
          ${items.length > 3 ? `<div class="more">+${items.length - 3} item(ns)</div>` : ''}
        </div>
      </div>

      <div class="order-foot">
        <div>
          <div class="order-total">${money(order.total)}</div>
          <span class="${order.payment_status === 'paid' ? 'tag-paid' : 'tag-unpaid'}">
            ${order.payment_status === 'paid' ? '✓ Pago' : '• Não pago'} · ${PAYMENT_LABEL[order.payment_method]}
          </span>
        </div>
        <div class="order-actions">
          <button class="btn btn-sm btn-ghost" data-detail="${order.id}" title="Detalhes">👁</button>
          ${nextAction ? `<button class="btn btn-sm ${nextAction.primary ? 'btn-primary' : ''}" data-status="${nextAction.status}" data-id="${order.id}">${nextAction.label}</button>` : ''}
          ${!['completed', 'cancelled'].includes(order.status) ? `<button class="btn btn-sm btn-danger" data-cancel="${order.id}" title="Cancelar pedido">✕</button>` : ''}
        </div>
      </div>
    </article>`;
}

function nextActionFor(order) {
  switch (order.status) {
    case 'pending': return { status: 'confirmed', label: 'Aceitar', primary: true };
    case 'confirmed': return { status: 'preparing', label: 'Iniciar preparo', primary: true };
    case 'preparing': return { status: 'ready', label: 'Marcar pronto', primary: true };
    case 'ready':
      return order.type === 'delivery'
        ? { status: 'out_for_delivery', label: 'Saiu p/ entrega', primary: true }
        : { status: 'completed', label: 'Concluir', primary: true };
    case 'out_for_delivery': return { status: 'completed', label: 'Entregue', primary: true };
    default: return null;
  }
}

function bindViewActions({ silent } = {}) {
  $$('[data-status]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await updateStatus(Number(btn.dataset.id), btn.dataset.status);
    });
  });
  $$('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await cancelOrder(Number(btn.dataset.cancel));
    });
  });
  $$('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showOrderDetail(Number(btn.dataset.detail));
    });
  });
  $$('.order-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      showOrderDetail(Number(card.dataset.orderId));
    });
  });
  if (!silent) return;
}

async function updateStatus(id, status) {
  try {
    await api(`/api/admin/orders/${id}/status`, { method: 'PATCH', auth: true, body: { status } });
    toast(`Pedido atualizado: ${STATUS_LABEL[status]}`, 'success', 2200);
    if (state.view === 'orders') renderOrders({ silent: true });
    if (state.view === 'dashboard') renderDashboard();
    if (state.view === 'tables') renderTables();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function cancelOrder(id) {
  const ok = await confirmDialog({
    title: 'Cancelar pedido',
    message: 'O pedido será marcado como cancelado e o cliente verá essa informação. Deseja continuar?',
    confirmText: 'Cancelar pedido',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/admin/orders/${id}/cancel`, { method: 'POST', auth: true, body: { reason: 'Cancelado pelo painel' } });
    toast('Pedido cancelado.', 'info');
    if (state.view === 'orders') renderOrders({ silent: true });
    else if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'tables') renderTables();
  } catch (err) { toast(err.message, 'error'); }
}

async function showOrderDetail(id) {
  let order;
  try {
    const res = await api(`/api/admin/orders/${id}`, { auth: true });
    order = res.order;
  } catch (err) { return toast(err.message, 'error'); }

  const canPay = !['cancelled'].includes(order.status);
  const next = nextActionFor(order);

  openModal(
    `<div class="modal-head">
       <div>
         <div class="row"><h3 class="mono">${esc(order.code)}</h3>${statusBadge(order.status)}</div>
         <p class="muted small mt-1">${TYPE_ICON[order.type]} ${TYPE_LABEL[order.type]} · ${fmtDateTime(order.created_at)}
         ${order.table_name ? ` · ${esc(order.table_name)}` : ''}</p>
       </div>
       <button class="modal-close" data-close>×</button>
     </div>
     <div class="modal-body">
       <div class="grid-2">
         <div class="card" style="padding:14px">
           <div class="kpi-label">Cliente</div>
           <strong>${esc(order.customer_name)}</strong><br>
           <span class="muted small">${esc(order.customer_phone || 'sem telefone')}</span>
           ${order.address ? `<p class="small mt-2">📍 ${esc(order.address)}</p>` : ''}
           ${order.notes ? `<p class="small mt-2 muted">📝 ${esc(order.notes)}</p>` : ''}
         </div>
         <div class="card" style="padding:14px">
           <div class="kpi-label">Pagamento</div>
           <strong>${PAYMENT_LABEL[order.payment_method]}</strong>
           <div class="mt-1">
             <span class="badge ${order.payment_status === 'paid' ? 'badge-ready' : 'badge-pending'}">
               ${order.payment_status === 'paid' ? 'Pago' : 'Pendente'}
             </span>
             ${order.change_for ? `<span class="tiny muted"> · troco para ${money(order.change_for)}</span>` : ''}
           </div>
           ${canPay ? `<button class="btn btn-sm ${order.payment_status === 'paid' ? '' : 'btn-soft'} mt-2" id="togglePay">
             ${order.payment_status === 'paid' ? 'Marcar como não pago' : 'Marcar como pago'}</button>` : ''}
         </div>
       </div>

       <div>
         <div class="label mb-2">Itens</div>
         <div class="stack" style="gap:8px">
           ${order.items
             .map(
               (i) => `<div class="between small">
                 <span>${i.qty}× ${esc(i.name)} ${i.notes ? `<span class="tiny muted">— ${esc(i.notes)}</span>` : ''}</span>
                 <strong>${money(i.unit_price * i.qty)}</strong>
               </div>`
             )
             .join('')}
         </div>
       </div>

       <div class="checkout-summary">
         <div class="line"><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
         ${order.delivery_fee ? `<div class="line"><span>Entrega</span><span>${money(order.delivery_fee)}</span></div>` : ''}
         ${order.discount ? `<div class="line" style="color:var(--green)"><span>Desconto ${esc(order.coupon || '')}</span><span>− ${money(order.discount)}</span></div>` : ''}
         <div class="line total"><span>Total</span><span>${money(order.total)}</span></div>
       </div>

       ${order.pix ? `<div>
          <div class="label mb-2">PIX copia e cola</div>
          <div class="code-box" id="detailPix">${esc(order.pix.payload)}</div>
          <button class="btn btn-sm mt-2" id="copyDetailPix">Copiar PIX</button>
        </div>` : ''}
     </div>

     <div class="modal-foot" style="justify-content:space-between;flex-wrap:wrap">
       <div class="row">
         <button class="btn btn-sm" id="printOrder">🖨 Imprimir</button>
         ${order.customer_phone ? `<a class="btn btn-sm btn-ghost" target="_blank" rel="noopener"
            href="${whatsappLink(order.customer_phone, `Olá ${order.customer_name}! Sobre seu pedido ${order.code}...`)}">WhatsApp</a>` : ''}
       </div>
       <div class="row">
         ${!['completed', 'cancelled'].includes(order.status) ? `<button class="btn btn-sm btn-danger" id="cancelOrder">Cancelar</button>` : ''}
         ${next ? `<button class="btn btn-primary" id="advanceOrder">${next.label}</button>` : ''}
         <button class="btn btn-ghost" data-close>Fechar</button>
       </div>
     </div>`,
    {
      className: 'modal-lg',
      onMount(root) {
        root.querySelector('#togglePay')?.addEventListener('click', async () => {
          try {
            await api(`/api/admin/orders/${order.id}/payment`, {
              method: 'PATCH', auth: true,
              body: { payment_status: order.payment_status === 'paid' ? 'unpaid' : 'paid' },
            });
            closeModal();
            toast('Pagamento atualizado.', 'success');
            if (state.view === 'orders') renderOrders({ silent: true });
            else if (state.view === 'dashboard') renderDashboard();
          } catch (err) { toast(err.message, 'error'); }
        });

        root.querySelector('#advanceOrder')?.addEventListener('click', async () => {
          closeModal();
          await updateStatus(order.id, next.status);
        });

        root.querySelector('#cancelOrder')?.addEventListener('click', async () => {
          closeModal();
          await cancelOrder(order.id);
        });

        root.querySelector('#printOrder')?.addEventListener('click', () => printOrder(order));

        root.querySelector('#copyDetailPix')?.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(order.pix.payload);
            toast('PIX copiado!', 'success');
          } catch { toast('Não foi possível copiar.', 'error'); }
        });
      },
    }
  );
}

function printOrder(order) {
  const win = window.open('', '_blank', 'width=380,height=640');
  if (!win) return toast('Permita pop-ups para imprimir.', 'error');
  const rows = order.items
    .map(
      (i) =>
        `<tr><td>${i.qty}×</td><td>${esc(i.name)}${i.notes ? `<br><small>${esc(i.notes)}</small>` : ''}</td>
         <td style="text-align:right">${money(i.unit_price * i.qty)}</td></tr>`
    )
    .join('');
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(order.code)}</title>
    <style>
      body{font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:12px;color:#000;width:300px;margin:0 auto}
      h1{font-size:16px;text-align:center;margin:0 0 4px}
      .c{text-align:center;font-size:11px;margin-bottom:10px}
      table{width:100%;border-collapse:collapse}
      td{padding:2px 0;vertical-align:top}
      hr{border:none;border-top:1px dashed #000;margin:8px 0}
      .line{display:flex;justify-content:space-between;padding:1px 0}
      .tot{font-weight:bold;font-size:13px}
      .b{font-weight:bold}
    </style></head><body>
    <h1>${esc(state.settings?.store_name || 'Sistema Food')}</h1>
    <div class="c">${esc(state.settings?.address || '')}<br>${esc(state.settings?.store_phone || '')}</div>
    <hr>
    <div class="line b"><span>${esc(order.code)}</span><span>${TYPE_LABEL[order.type]}</span></div>
    <div class="line"><span>${new Date(order.created_at).toLocaleString('pt-BR')}</span></div>
    <div class="line"><span>${esc(order.customer_name)}</span></div>
    ${order.customer_phone ? `<div class="line"><span>${esc(order.customer_phone)}</span></div>` : ''}
    ${order.table_name ? `<div class="line"><span>${esc(order.table_name)}</span></div>` : ''}
    ${order.address ? `<div class="line" style="font-size:10px">${esc(order.address)}</div>` : ''}
    <hr>
    <table>${rows}</table>
    <hr>
    <div class="line"><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
    ${order.delivery_fee ? `<div class="line"><span>Entrega</span><span>${money(order.delivery_fee)}</span></div>` : ''}
    ${order.discount ? `<div class="line"><span>Desconto</span><span>-${money(order.discount)}</span></div>` : ''}
    <div class="line tot"><span>TOTAL</span><span>${money(order.total)}</span></div>
    <div class="line"><span>Pagamento</span><span>${PAYMENT_LABEL[order.payment_method]}</span></div>
    ${order.notes ? `<hr><div style="font-size:10px">Obs: ${esc(order.notes)}</div>` : ''}
    <hr>
    <div class="c">Obrigado pela preferência! 🍔</div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
  win.document.close();
}

// util
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ================================================================ PDV
async function renderPOS() {
  const [{ products, categories }, { tables }] = await Promise.all([
    api('/api/admin/products', { auth: true }),
    api('/api/admin/tables', { auth: true }),
  ]);
  state.products = products;
  state.categories = categories;
  state.tables = tables;
  state.pos = { items: [], type: 'pos', tableId: null, payment: 'cash', coupon: '', discount: 0, name: '', phone: '', address: '', notes: '' };

  const types = [
    ['pos', '🏪', 'Balcão'],
    ['dinein', '🍽️', 'Mesa'],
    ['pickup', '🥡', 'Retirada'],
    ['delivery', '🛵', 'Entrega'],
  ];

  $('#view').innerHTML = `
    <div class="pos-layout">
      <div class="stack" style="gap:12px">
        <div class="card" style="padding:13px">
          <div class="row wrap">
            <input class="input" id="posSearch" placeholder="🔎 Buscar produto..." style="max-width:260px" />
            <div class="tabs" id="posCats" style="flex:1">
              <button class="tab active" data-cat="all">Tudo</button>
              ${categories
                .filter((c) => c.active)
                .map((c) => `<button class="tab" data-cat="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`)
                .join('')}
            </div>
          </div>
        </div>
        <div class="pos-products" id="posProducts"></div>
      </div>

      <div class="pos-cart">
        <div class="between">
          <h3 class="card-title">Comanda</h3>
          <div class="row">
            <span class="badge badge-completed" id="posCount">0 itens</span>
            <button class="btn btn-sm btn-ghost" id="posClear" title="Limpar comanda">🗑</button>
          </div>
        </div>

        <div class="pos-type-grid" id="posTypes">
          ${types
            .map(
              ([v, ico, label]) =>
                `<button class="pos-type ${v === 'pos' ? 'active' : ''}" data-type="${v}"><span>${ico}</span>${label}</button>`
            )
            .join('')}
        </div>

        <div id="posTableWrap" class="field hidden">
          <label>Mesa</label>
          <select class="select" id="posTable">
            <option value="">Selecione a mesa...</option>
            ${tables
              .map(
                (t) =>
                  `<option value="${t.id}">${esc(t.name)}${t.status === 'occupied' ? ' · ocupada' : ''} (${t.seats} lug.)</option>`
              )
              .join('')}
          </select>
        </div>

        <div class="pos-cart-items" id="posItems"></div>

        <div class="grid-2">
          <div class="field">
            <label>Cliente</label>
            <input class="input" id="posName" placeholder="Nome" maxlength="80" />
          </div>
          <div class="field">
            <label>Telefone</label>
            <input class="input" id="posPhone" inputmode="tel" placeholder="(69) 9..." maxlength="16" />
          </div>
        </div>

        <div class="field hidden" id="posAddressWrap">
          <label>Endereço de entrega</label>
          <textarea class="textarea" id="posAddress" rows="2" placeholder="Rua, número, bairro..." style="min-height:56px"></textarea>
        </div>

        <div class="grid-2">
          <div class="field">
            <label>Pagamento</label>
            <select class="select" id="posPayment">
              <option value="cash">💵 Dinheiro</option>
              <option value="card">💳 Cartão</option>
              <option value="pix">💠 PIX</option>
            </select>
          </div>
          <div class="field">
            <label>Cupom</label>
            <div class="row" style="gap:5px">
              <input class="input" id="posCoupon" placeholder="CÓDIGO" style="text-transform:uppercase" />
              <button class="btn btn-sm" id="posApplyCoupon" style="padding:9px 10px">OK</button>
            </div>
          </div>
        </div>

        <div class="field">
          <label>Observações</label>
          <input class="input" id="posNotes" placeholder="Ex: sem cebola, embalar separado..." maxlength="300" />
        </div>

        <div class="totals" id="posTotals"></div>

        <button class="btn btn-primary btn-lg btn-block" id="posFinish">Finalizar pedido</button>
        <p class="tiny muted center" style="margin-top:-4px">Atalhos: F2 abre o PDV · F3 abre os pedidos</p>
      </div>
    </div>`;

  posPaintProducts();
  posPaintCart();

  $('#posSearch').addEventListener('input', debounce(posPaintProducts, 180));
  $('#posCats').querySelectorAll('[data-cat]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.posCat = btn.dataset.cat;
      $('#posCats').querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      posPaintProducts();
    })
  );
  $('#posTypes').querySelectorAll('[data-type]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.pos.type = btn.dataset.type;
      $('#posTypes').querySelectorAll('.pos-type').forEach((b) => b.classList.toggle('active', b === btn));
      if (state.pos.type !== 'dinein') $('#posTable').value = '';
      posPaintFields();
      posPaintCart();
    })
  );
  $('#posTable').addEventListener('change', (e) => { state.pos.tableId = e.target.value ? Number(e.target.value) : null; });
  $('#posPayment').addEventListener('change', (e) => { state.pos.payment = e.target.value; });
  $('#posName').addEventListener('input', (e) => { state.pos.name = e.target.value; });
  const phone = $('#posPhone');
  phone.addEventListener('input', () => { phone.value = maskPhone(phone.value); state.pos.phone = phone.value; });
  $('#posAddress').addEventListener('input', (e) => { state.pos.address = e.target.value; });
  $('#posNotes').addEventListener('input', (e) => { state.pos.notes = e.target.value; });
  $('#posApplyCoupon').addEventListener('click', async () => {
    const code = $('#posCoupon').value.trim().toUpperCase();
    if (!code) return;
    try {
      const res = await api('/api/coupons/validate', {
        method: 'POST', body: { code, subtotal: posSubtotal() },
      });
      state.pos.coupon = res.code;
      state.pos.discount = res.discount;
      posPaintCart();
      toast(`Cupom aplicado: − ${money(res.discount)}`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#posClear').addEventListener('click', () => {
    if (!state.pos.items.length) return;
    state.pos.items = [];
    state.pos.coupon = '';
    state.pos.discount = 0;
    posPaintCart();
  });
  $('#posFinish').addEventListener('click', finishPOS);
}

function posSubtotal() {
  return state.pos.items.reduce((a, i) => a + i.price * i.qty, 0);
}

function posTotals() {
  const subtotal = posSubtotal();
  const s = state.settings || {};
  let delivery = 0;
  if (state.pos.type === 'delivery') {
    const freeAbove = Number(s.free_delivery_above) || 0;
    delivery = freeAbove > 0 && subtotal >= freeAbove ? 0 : Number(s.delivery_fee) || 0;
  }
  const discount = Math.min(state.pos.discount || 0, subtotal);
  return { subtotal, delivery, discount, total: Math.max(0, subtotal + delivery - discount) };
}

function posPaintProducts() {
  const host = $('#posProducts');
  if (!host) return;
  const cat = state.posCat || 'all';
  const search = ($('#posSearch')?.value || '').toLowerCase().trim();
  const list = state.products
    .filter((p) => p.active)
    .filter((p) => cat === 'all' || String(p.category_id) === String(cat))
    .filter((p) => !search || p.name.toLowerCase().includes(search));

  host.innerHTML = list.length
    ? list
        .map((p) => {
          const inCart = state.pos.items.find((i) => i.productId === p.id);
          return `<button class="pos-card" data-add="${p.id}" style="${inCart ? 'border-color:rgba(255,107,44,.5)' : ''}">
            <span class="pc-emoji">${esc(p.emoji || '🍽️')}</span>
            <span class="pc-name">${esc(p.name)}</span>
            <span class="pc-price">${money(p.promo_price ?? p.price)} ${inCart ? `<span class="badge badge-preparing" style="margin-left:4px">${inCart.qty}</span>` : ''}</span>
          </button>`;
        })
        .join('')
    : `<div class="empty" style="grid-column:1/-1"><span class="emoji">🔍</span><small>Nenhum produto encontrado.</small></div>`;

  host.querySelectorAll('[data-add]').forEach((btn) =>
    btn.addEventListener('click', () => posAdd(Number(btn.dataset.add), 1))
  );
}

function posPaintFields() {
  $('#posTableWrap')?.classList.toggle('hidden', state.pos.type !== 'dinein');
  $('#posAddressWrap')?.classList.toggle('hidden', state.pos.type !== 'delivery');
  const nameInput = $('#posName');
  if (nameInput && state.pos.type === 'pos') nameInput.placeholder = 'Cliente balcão';
}

function posPaintCart() {
  const host = $('#posItems');
  if (!host) return;
  const count = state.pos.items.reduce((a, i) => a + i.qty, 0);
  $('#posCount').textContent = `${count} item${count === 1 ? '' : 's'}`;

  host.innerHTML = state.pos.items.length
    ? state.pos.items
        .map(
          (item, i) => `<div class="pos-row">
            <span>${esc(item.emoji || '')}</span>
            <div class="grow" style="min-width:0">
              <div style="font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.name)}</div>
              <small class="muted">${money(item.price)} un.</small>
            </div>
            <div class="qty-ctl">
              <button data-pos="dec" data-i="${i}">−</button>
              <span>${item.qty}</span>
              <button data-pos="inc" data-i="${i}">+</button>
            </div>
            <strong style="min-width:64px;text-align:right">${money(item.price * item.qty)}</strong>
          </div>`
        )
        .join('')
    : `<div class="empty-cart" style="padding:26px"><div class="big">🧾</div><small>Toque nos produtos<br>para montar a comanda.</small></div>`;

  host.querySelectorAll('[data-pos]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      posAdd(state.pos.items[i].productId, btn.dataset.pos === 'inc' ? 1 : -1);
    })
  );

  const t = posTotals();
  $('#posTotals').innerHTML = `
    <div class="line"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
    ${state.pos.type === 'delivery' ? `<div class="line"><span>Entrega</span><span>${t.delivery ? money(t.delivery) : 'Grátis'}</span></div>` : ''}
    ${t.discount ? `<div class="line discount"><span>Cupom ${esc(state.pos.coupon)}</span><span>− ${money(t.discount)}</span></div>` : ''}
    <div class="line total"><span>Total</span><span>${money(t.total)}</span></div>`;

  const finish = $('#posFinish');
  if (finish) finish.textContent = state.pos.items.length ? `Finalizar · ${money(t.total)}` : 'Finalizar pedido';
}

function posAdd(productId, delta) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  const existing = state.pos.items.find((i) => i.productId === productId);
  if (existing) {
    existing.qty += delta;
    if (existing.qty <= 0) state.pos.items = state.pos.items.filter((i) => i !== existing);
  } else if (delta > 0) {
    state.pos.items.push({
      productId,
      name: product.name,
      emoji: product.emoji,
      price: product.promo_price ?? product.price,
      qty: 1,
    });
  }
  state.pos.discount = 0;
  state.pos.coupon = '';
  if ($('#posCoupon')) $('#posCoupon').value = '';
  posPaintCart();
  posPaintProducts();
}

async function finishPOS() {
  const p = state.pos;
  if (!p.items.length) return toast('Adicione pelo menos um item.', 'error');
  if (p.type === 'dinein' && !p.tableId) return toast('Escolha a mesa.', 'error');
  if (p.type === 'delivery' && (!p.name.trim() || onlyDigits(p.phone).length < 10 || p.address.trim().length < 8)) {
    return toast('Preencha nome, telefone e endereço da entrega.', 'error');
  }

  const btn = $('#posFinish');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Registrando...';

  try {
    const { order } = await api('/api/admin/orders', {
      method: 'POST', auth: true,
      body: {
        type: p.type,
        customer_name: p.name.trim() || 'Cliente balcão',
        customer_phone: p.phone,
        address: p.type === 'delivery' ? p.address : '',
        table_id: p.type === 'dinein' ? p.tableId : null,
        payment_method: p.payment,
        notes: p.notes,
        coupon: p.coupon,
        items: p.items.map((i) => ({ product_id: i.productId, qty: i.qty })),
      },
    });

    toast(`Pedido ${order.code} registrado!`, 'success');
    posSuccess(order);
    state.pos.items = [];
    state.pos.discount = 0;
    state.pos.coupon = '';
    state.pos.name = '';
    state.pos.phone = '';
    state.pos.address = '';
    state.pos.notes = '';
    state.pos.tableId = null;

    const { tables } = await api('/api/admin/tables', { auth: true });
    state.tables = tables;
    renderPOSRefreshTables(tables);
    posPaintCart();
    posPaintProducts();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    posPaintCart();
  }
}

function renderPOSRefreshTables(tables) {
  const select = $('#posTable');
  if (!select) return;
  select.innerHTML =
    `<option value="">Selecione a mesa...</option>` +
    tables
      .map((t) => `<option value="${t.id}">${esc(t.name)}${t.status === 'occupied' ? ' · ocupada' : ''} (${t.seats} lug.)</option>`)
      .join('');
}

function posSuccess(order) {
  openModal(
    `<div class="modal-head"><h3>Pedido registrado ✅</h3><button class="modal-close" data-close>×</button></div>
     <div class="modal-body">
       <div class="success-box">
         <div class="success-emoji">🧾</div>
         <div class="success-code">${esc(order.code)}</div>
         <p class="small muted">${TYPE_ICON[order.type]} ${TYPE_LABEL[order.type]} · ${money(order.total)} · ${PAYMENT_LABEL[order.payment_method]}</p>
       </div>
       ${order.pix ? `<div class="pix-box"><div class="between mb-2"><strong class="small">💠 PIX</strong>
         <button class="btn btn-sm btn-primary" id="posCopyPix">Copiar</button></div>
         <div class="pix-code">${esc(order.pix.payload)}</div></div>` : ''}
       <div class="row">
         <button class="btn grow" id="posPrint">🖨 Imprimir cupom</button>
         <button class="btn btn-primary grow" data-close>Próximo pedido</button>
       </div>
     </div>`,
    {
      onMount(root) {
        root.querySelector('#posPrint').addEventListener('click', () => printOrder(order));
        root.querySelector('#posCopyPix')?.addEventListener('click', async () => {
          await navigator.clipboard.writeText(order.pix.payload).catch(() => {});
          toast('PIX copiado!', 'success');
        });
      },
    }
  );
}

// ================================================================ MESAS
async function renderTables() {
  const { tables } = await api('/api/admin/tables', { auth: true });
  state.tables = tables;
  const occupied = tables.filter((t) => t.status === 'occupied').length;
  const canManage = ['admin', 'manager'].includes(state.user.role);

  $('#view').innerHTML = `
    <div class="row wrap">
      <span class="badge badge-completed">${tables.length} mesas</span>
      <span class="badge badge-preparing">${occupied} ocupadas</span>
      <span class="badge badge-ready">${tables.length - occupied} livres</span>
      <div style="margin-left:auto" class="row">
        <button class="btn btn-sm" id="refreshTables">↻ Atualizar</button>
        ${canManage ? `<button class="btn btn-sm btn-primary" id="addTable">+ Nova mesa</button>` : ''}
      </div>
    </div>

    <div class="tables-grid">
      ${tables
        .map(
          (t) => `
        <div class="table-card ${t.status === 'occupied' ? 'occupied' : ''}" data-table="${t.id}">
          ${canManage ? `<div class="table-actions">
            <button class="btn btn-sm btn-ghost" data-edit-table="${t.id}" title="Editar">✎</button>
            <button class="btn btn-sm btn-danger" data-del-table="${t.id}" title="Excluir">✕</button>
          </div>` : ''}
          <span class="table-num">${esc(t.name)}</span>
          <span class="table-status">${t.status === 'occupied' ? '● Ocupada' : '○ Livre'}</span>
          <span class="table-open">${t.seats} lugares</span>
          ${t.open_order
            ? `<span class="table-open" style="color:var(--brand-2)">${esc(t.open_order.code)} · ${money(t.open_order.total)}</span>`
            : `<span class="table-open">Toque para abrir comanda</span>`}
        </div>`
        )
        .join('')}
    </div>

    <div class="alert alert-info small">
      💡 Toque em uma mesa livre para abrir uma comanda no PDV. Pedidos no cardápio online com “Pedir na mesa” também aparecem aqui.
    </div>`;

  if (canManage) {
    $('#addTable').addEventListener('click', () => tableForm());
    $$('[data-edit-table]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = tables.find((x) => x.id === Number(b.dataset.editTable));
        if (t) tableForm(t);
      })
    );
    $$('[data-del-table]').forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const t = tables.find((x) => x.id === Number(b.dataset.delTable));
        const ok = await confirmDialog({ title: 'Excluir mesa', message: `Excluir ${t.name}?`, confirmText: 'Excluir', danger: true });
        if (!ok) return;
        try {
          await api(`/api/admin/tables/${t.id}`, { method: 'DELETE', auth: true });
          toast('Mesa excluída.', 'success');
          renderTables();
        } catch (err) { toast(err.message, 'error'); }
      })
    );
  }

  $$('.table-card').forEach((card) =>
    card.addEventListener('click', async (e) => {
      if (e.target.closest('button')) return;
      const table = tables.find((t) => t.id === Number(card.dataset.table));
      if (table.open_order) {
        showOrderDetail(table.open_order.id);
      } else {
        await renderPOS();
        state.pos.type = 'dinein';
        state.pos.tableId = table.id;
        $('#posTypes').querySelectorAll('.pos-type').forEach((b) => b.classList.toggle('active', b.dataset.type === 'dinein'));
        $('#posTable').value = String(table.id);
        posPaintFields();
        toast(`Comanda aberta para ${table.name}.`, 'info');
      }
    })
  );
  $('#refreshTables').addEventListener('click', () => renderTables());
}

function tableForm(table = null) {
  openModal(
    `<div class="modal-head"><h3>${table ? 'Editar mesa' : 'Nova mesa'}</h3><button class="modal-close" data-close>×</button></div>
     <div class="modal-body">
       <div class="field"><label>Nome</label>
         <input class="input" id="tName" value="${esc(table?.name || '')}" placeholder="Mesa 11" /></div>
       <div class="field"><label>Lugares</label>
         <input class="input" id="tSeats" type="number" min="1" max="30" value="${table?.seats || 4}" /></div>
     </div>
     <div class="modal-foot">
       <button class="btn btn-ghost" data-close>Cancelar</button>
       <button class="btn btn-primary" id="saveTable">Salvar</button>
     </div>`,
    {
      onMount(root) {
        root.querySelector('#saveTable').addEventListener('click', async () => {
          const name = root.querySelector('#tName').value.trim();
          const seats = Number(root.querySelector('#tSeats').value) || 4;
          if (!name) return toast('Informe o nome da mesa.', 'error');
          try {
            if (table) {
              await api(`/api/admin/tables/${table.id}`, {
                method: 'PUT', auth: true, body: { name, seats, status: table.status },
              });
            } else {
              await api('/api/admin/tables', { method: 'POST', auth: true, body: { name, seats } });
            }
            closeModal();
            toast('Mesa salva.', 'success');
            renderTables();
          } catch (err) { toast(err.message, 'error'); }
        });
      },
    }
  );
}

// ================================================================ CARDÁPIO
function toCents(value) {
  let s = String(value ?? '').trim().replace(/R\$/g, '').replace(/\s/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const fromCents = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',');

async function renderMenuAdmin() {
  const { products, categories } = await api('/api/admin/products', { auth: true });
  state.products = products;
  state.categories = categories;
  const canManage = ['admin', 'manager'].includes(state.user.role);
  state.menuCat = state.menuCat || 'all';
  state.menuSearch = state.menuSearch || '';

  const filtered = products.filter(
    (p) =>
      (state.menuCat === 'all' || String(p.category_id) === String(state.menuCat)) &&
      (!state.menuSearch || p.name.toLowerCase().includes(state.menuSearch.toLowerCase()))
  );
  const groups = categories
    .map((c) => ({ ...c, items: filtered.filter((p) => p.category_id === c.id) }))
    .filter((g) => g.items.length);
  const noCat = filtered.filter((p) => !p.category_id);

  const row = (p) => `
    <div class="admin-product ${p.active ? '' : 'off'}">
      <div class="thumb">${esc(p.emoji || '🍽️')}</div>
      <div class="info">
        <strong>${esc(p.name)}</strong>
        <small>${money(p.promo_price ?? p.price)}${p.promo_price ? ` <s>${money(p.price)}</s>` : ''} · ⏱ ${p.prep_time} min</small>
      </div>
      <label class="switch" title="Disponível no cardápio">
        <input type="checkbox" data-toggle="${p.id}" ${p.active ? 'checked' : ''} ${canManage ? '' : 'disabled'} />
        <span></span>
      </label>
      ${canManage ? `<div class="prod-actions">
        <button class="btn btn-sm btn-ghost" data-edit="${p.id}" title="Editar">✎</button>
        <button class="btn btn-sm btn-danger" data-del="${p.id}" title="Excluir">🗑</button>
      </div>` : ''}
    </div>`;

  $('#view').innerHTML = `
    <div class="row wrap">
      <input class="input" id="menuSearch" placeholder="🔎 Buscar produto..." style="max-width:250px" value="${esc(state.menuSearch)}" />
      <select class="select" id="menuCatFilter" style="max-width:200px">
        <option value="all">Todas as categorias</option>
        ${categories.map((c) => `<option value="${c.id}" ${String(state.menuCat) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <span class="muted small">${products.filter((p) => p.active).length} ativos de ${products.length}</span>
      <div style="margin-left:auto" class="row">
        ${canManage ? `<button class="btn btn-sm" id="manageCats">📁 Categorias</button>
        <button class="btn btn-sm btn-primary" id="addProduct">+ Novo produto</button>` : ''}
      </div>
    </div>

    ${groups.length ? groups.map((g) => `
      <div class="card" style="padding:0;overflow:hidden">
        <div class="between" style="padding:13px 16px;border-bottom:1px solid var(--line);background:var(--bg-soft)">
          <strong>${esc(g.emoji)} ${esc(g.name)}</strong>
          <span class="tiny muted">${g.items.length} produto(s)</span>
        </div>
        ${g.items.map(row).join('')}
      </div>`).join('') : ''}

    ${noCat.length ? `<div class="card" style="padding:0;overflow:hidden">
      <div style="padding:13px 16px;border-bottom:1px solid var(--line);background:var(--bg-soft)"><strong>Sem categoria</strong></div>
      ${noCat.map(row).join('')}
    </div>` : ''}

    ${!groups.length && !noCat.length ? `<div class="empty"><span class="emoji">🍽️</span><p>Nenhum produto encontrado.</p></div>` : ''}`;

  $('#menuSearch').addEventListener('input', debounce((e) => {
    state.menuSearch = e.target.value;
    renderMenuAdmin();
  }, 300));
  $('#menuCatFilter').addEventListener('change', (e) => {
    state.menuCat = e.target.value;
    renderMenuAdmin();
  });
  $('#addProduct')?.addEventListener('click', () => productForm());
  $('#manageCats')?.addEventListener('click', categoriesModal);

  $$('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => productForm(products.find((p) => p.id === Number(b.dataset.edit))))
  );
  $$('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = products.find((x) => x.id === Number(b.dataset.del));
      const ok = await confirmDialog({
        title: 'Excluir produto',
        message: `Excluir "${p.name}" do cardápio? Produtos já vendidos são apenas desativados.`,
        confirmText: 'Excluir', danger: true,
      });
      if (!ok) return;
      try {
        const res = await api(`/api/admin/products/${p.id}`, { method: 'DELETE', auth: true });
        toast(res.message || 'Produto excluído.', 'success');
        renderMenuAdmin();
      } catch (err) { toast(err.message, 'error'); }
    })
  );
  $$('[data-toggle]').forEach((input) =>
    input.addEventListener('change', async () => {
      const p = products.find((x) => x.id === Number(input.dataset.toggle));
      try {
        await api(`/api/admin/products/${p.id}`, {
          method: 'PUT', auth: true,
          body: {
            category_id: p.category_id, name: p.name, description: p.description,
            price: p.price, promo_price: p.promo_price, emoji: p.emoji,
            prep_time: p.prep_time, active: input.checked,
          },
        });
        toast(input.checked ? 'Produto disponível.' : 'Produto pausado.', 'success', 1800);
        p.active = input.checked ? 1 : 0;
      } catch (err) {
        input.checked = !input.checked;
        toast(err.message, 'error');
      }
    })
  );
}

function productForm(product = null) {
  const cats = state.categories.filter((c) => c.active);
  openModal(
    `<div class="modal-head"><h3>${product ? 'Editar produto' : 'Novo produto'}</h3><button class="modal-close" data-close>×</button></div>
     <div class="modal-body">
       <div class="grid-2">
         <div class="field"><label>Nome *</label><input class="input" id="pName" maxlength="90" value="${esc(product?.name || '')}" placeholder="X-Burger Especial" /></div>
         <div class="field"><label>Categoria</label>
           <select class="select" id="pCat">
             <option value="">Sem categoria</option>
             ${cats.map((c) => `<option value="${c.id}" ${product?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
           </select>
         </div>
       </div>
       <div class="grid-3">
         <div class="field"><label>Preço (R$) *</label><input class="input" id="pPrice" inputmode="decimal" value="${product ? fromCents(product.price) : ''}" placeholder="29,90" /></div>
         <div class="field"><label>Promo (R$)</label><input class="input" id="pPromo" inputmode="decimal" value="${product?.promo_price ? fromCents(product.promo_price) : ''}" placeholder="opcional" /></div>
         <div class="field"><label>Preparo (min)</label><input class="input" id="pPrep" type="number" min="0" max="180" value="${product?.prep_time ?? 20}" /></div>
       </div>
       <div class="grid-2">
         <div class="field"><label>Emoji / ícone</label><input class="input" id="pEmoji" maxlength="8" value="${esc(product?.emoji || '🍔')}" /></div>
         <div class="field" style="justify-content:flex-end">
           <label class="checkbox"><input type="checkbox" id="pActive" ${product ? (product.active ? 'checked' : '') : 'checked'} /> Disponível no cardápio</label>
         </div>
       </div>
       <div class="field"><label>Descrição</label>
         <textarea class="textarea" id="pDesc" maxlength="400" rows="3" placeholder="Ingredientes e detalhes do produto">${esc(product?.description || '')}</textarea></div>
       <p class="form-error" id="pError"></p>
     </div>
     <div class="modal-foot">
       <button class="btn btn-ghost" data-close>Cancelar</button>
       <button class="btn btn-primary" id="saveProduct">Salvar produto</button>
     </div>`,
    {
      onMount(root) {
        root.querySelector('#saveProduct').addEventListener('click', async () => {
          const err = root.querySelector('#pError');
          const name = root.querySelector('#pName').value.trim();
          const price = toCents(root.querySelector('#pPrice').value);
          const promoRaw = root.querySelector('#pPromo').value.trim();
          const promo = promoRaw ? toCents(promoRaw) : null;
          if (name.length < 2) { err.textContent = 'Informe o nome.'; return; }
          if (price <= 0) { err.textContent = 'Informe um preço válido.'; return; }
          if (promo !== null && (promo <= 0 || promo >= price)) {
            err.textContent = 'A promoção deve ser menor que o preço normal.';
            return;
          }
          const body = {
            category_id: root.querySelector('#pCat').value || null,
            name,
            price,
            promo_price: promo,
            prep_time: Number(root.querySelector('#pPrep').value) || 0,
            emoji: root.querySelector('#pEmoji').value || '🍽️',
            description: root.querySelector('#pDesc').value,
            active: root.querySelector('#pActive').checked,
          };
          const btn = root.querySelector('#saveProduct');
          btn.disabled = true;
          try {
            if (product) await api(`/api/admin/products/${product.id}`, { method: 'PUT', auth: true, body });
            else await api('/api/admin/products', { method: 'POST', auth: true, body });
            closeModal();
            toast('Produto salvo.', 'success');
            renderMenuAdmin();
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        });
      },
    }
  );
}

function categoriesModal() {
  const paint = () => {
    const root = document.querySelector('.modal');
    if (!root) return;
    root.querySelector('#catList').innerHTML = state.categories.length
      ? state.categories
          .map(
            (c) => `<div class="between" style="padding:9px 0;border-bottom:1px solid var(--line)">
              <span>${esc(c.emoji)} <strong class="small">${esc(c.name)}</strong>
                <span class="tiny muted">· ${c.products_count ?? ''}${c.products !== undefined ? c.products + ' itens' : ''}</span></span>
              <span class="row">
                <button class="btn btn-sm btn-ghost" data-cedit="${c.id}">✎</button>
                <button class="btn btn-sm btn-danger" data-cdel="${c.id}">✕</button>
              </span>
            </div>`
          )
          .join('')
      : `<p class="muted small">Nenhuma categoria.</p>`;
    root.querySelectorAll('[data-cedit]').forEach((b) =>
      b.addEventListener('click', () => catPrompt(state.categories.find((c) => c.id === Number(b.dataset.cedit))))
    );
    root.querySelectorAll('[data-cdel]').forEach((b) =>
      b.addEventListener('click', async () => {
        const cat = state.categories.find((c) => c.id === Number(b.dataset.cdel));
        const ok = await confirmDialog({
          title: 'Excluir categoria',
          message: `Excluir "${cat.name}"? Os produtos ficam sem categoria.`,
          confirmText: 'Excluir', danger: true,
        });
        if (!ok) return;
        await api(`/api/admin/categories/${cat.id}`, { method: 'DELETE', auth: true }).catch((e) => toast(e.message, 'error'));
        await reloadCategories();
        paint();
      })
    );
  };

  const reloadCategories = async () => {
    const data = await api('/api/admin/products', { auth: true });
    state.categories = data.categories;
    state.products = data.products;
  };

  const catPrompt = (cat = null) => {
    openModal(
      `<div class="modal-head"><h3>${cat ? 'Editar' : 'Nova'} categoria</h3><button class="modal-close" data-close>×</button></div>
       <div class="modal-body">
         <div class="grid-2">
           <div class="field"><label>Nome</label><input class="input" id="cName" value="${esc(cat?.name || '')}" placeholder="Sobremesas" /></div>
           <div class="field"><label>Emoji</label><input class="input" id="cEmoji" maxlength="8" value="${esc(cat?.emoji || '🍨')}" /></div>
         </div>
         <div class="field"><label>Ordem</label><input class="input" id="cSort" type="number" value="${cat?.sort ?? state.categories.length + 1}" /></div>
       </div>
       <div class="modal-foot">
         <button class="btn btn-ghost" data-close>Cancelar</button>
         <button class="btn btn-primary" id="saveCat">Salvar</button>
       </div>`,
      {
        onMount(root) {
          root.querySelector('#saveCat').addEventListener('click', async () => {
            const body = {
              name: root.querySelector('#cName').value.trim(),
              emoji: root.querySelector('#cEmoji').value,
              sort: Number(root.querySelector('#cSort').value) || 0,
              active: true,
            };
            if (!body.name) return toast('Informe o nome.', 'error');
            try {
              if (cat) await api(`/api/admin/categories/${cat.id}`, { method: 'PUT', auth: true, body });
              else await api('/api/admin/categories', { method: 'POST', auth: true, body });
              await reloadCategories();
              closeModal();
              toast('Categoria salva.', 'success');
              renderMenuAdmin();
            } catch (err) { toast(err.message, 'error'); }
          });
        },
      }
    );
  };

  openModal(
    `<div class="modal-head"><h3>Categorias do cardápio</h3><button class="modal-close" data-close>×</button></div>
     <div class="modal-body">
       <div id="catList"></div>
       <button class="btn btn-soft btn-block" id="newCat">+ Nova categoria</button>
     </div>
     <div class="modal-foot"><button class="btn btn-ghost" data-close>Fechar</button></div>`,
    {
      onMount(root) {
        root.querySelector('#newCat').addEventListener('click', () => catPrompt());
        paint();
      },
    }
  );
}

// ================================================================ CUPONS
async function renderCoupons() {
  const { coupons } = await api('/api/admin/coupons', { auth: true });

  $('#view').innerHTML = `
    <div class="row wrap">
      <p class="muted small">Cupons são aplicados no carrinho do cardápio online ou no PDV.</p>
      <button class="btn btn-sm btn-primary" style="margin-left:auto" id="addCoupon">+ Novo cupom</button>
    </div>
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th>Código</th><th>Desconto</th><th>Mínimo</th><th>Usos</th><th>Validade</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${coupons
            .map(
              (c) => `<tr>
                <td><strong class="mono">${esc(c.code)}</strong></td>
                <td>${c.type === 'percent' ? `${c.value}%` : money(c.value)}</td>
                <td>${c.min_total ? money(c.min_total) : '—'}</td>
                <td>${c.uses}${c.max_uses ? ` / ${c.max_uses}` : ''}</td>
                <td>${c.expires_at ? new Date(c.expires_at).toLocaleDateString('pt-BR') : 'sem prazo'}</td>
                <td><span class="badge ${c.active ? 'badge-ready' : 'badge-completed'}">${c.active ? 'Ativo' : 'Inativo'}</span></td>
                <td>
                  <div class="prod-actions" style="justify-content:flex-end">
                    <button class="btn btn-sm btn-ghost" data-cedit="${esc(c.code)}">✎</button>
                    <button class="btn btn-sm btn-danger" data-cdel="${esc(c.code)}">🗑</button>
                  </div>
                </td>
              </tr>`
            )
            .join('') || `<tr><td colspan="7"><div class="empty"><span class="emoji">🎟️</span><p>Nenhum cupom cadastrado.</p></div></td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h3 class="card-title mb-2">Como usar</h3>
      <p class="muted small">Divulgue o código nas redes sociais. Ex: <span class="kbd">BEMVINDO10</span> dá 10% de desconto em pedidos acima de R$ 30,00.
      O desconto é validado no servidor, então não tem como burlar pelo navegador.</p>
    </div>`;

  $('#addCoupon').addEventListener('click', () => couponForm());
  $$('[data-cedit]').forEach((b) =>
    b.addEventListener('click', () => couponForm(coupons.find((c) => c.code === b.dataset.cedit)))
  );
  $$('[data-cdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Excluir cupom', message: `Excluir ${b.dataset.cdel}?`, confirmText: 'Excluir', danger: true });
      if (!ok) return;
      await api(`/api/admin/coupons/${b.dataset.cdel}`, { method: 'DELETE', auth: true });
      toast('Cupom excluído.', 'success');
      renderCoupons();
    })
  );
}

function couponForm(coupon = null) {
  openModal(
    `<div class="modal-head"><h3>${coupon ? 'Editar cupom' : 'Novo cupom'}</h3><button class="modal-close" data-close>×</button></div>
     <div class="modal-body">
       <div class="grid-2">
         <div class="field"><label>Código *</label><input class="input" id="kCode" maxlength="30" value="${esc(coupon?.code || '')}" placeholder="BEMVINDO10" style="text-transform:uppercase" ${coupon ? 'disabled' : ''} /></div>
         <div class="field"><label>Tipo</label>
           <select class="select" id="kType">
             <option value="percent" ${coupon?.type === 'percent' ? 'selected' : ''}>Percentual (%)</option>
             <option value="fixed" ${coupon?.type === 'fixed' ? 'selected' : ''}>Valor fixo (R$)</option>
           </select>
         </div>
       </div>
       <div class="grid-2">
         <div class="field"><label>Desconto *</label><input class="input" id="kValue" inputmode="decimal" value="${coupon ? (coupon.type === 'percent' ? coupon.value : fromCents(coupon.value)) : ''}" placeholder="10" /></div>
         <div class="field"><label>Pedido mínimo (R$)</label><input class="input" id="kMin" inputmode="decimal" value="${coupon?.min_total ? fromCents(coupon.min_total) : ''}" placeholder="0,00" /></div>
       </div>
       <div class="grid-2">
         <div class="field"><label>Limite de usos (0 = ilimitado)</label><input class="input" id="kMax" type="number" min="0" value="${coupon?.max_uses ?? 0}" /></div>
         <div class="field"><label>Validade</label><input class="input" id="kExp" type="date" value="${coupon?.expires_at ? coupon.expires_at.slice(0, 10) : ''}" /></div>
       </div>
       <label class="checkbox"><input type="checkbox" id="kActive" ${!coupon || coupon.active ? 'checked' : ''} /> Cupom ativo</label>
       <p class="form-error" id="kError"></p>
     </div>
     <div class="modal-foot">
       <button class="btn btn-ghost" data-close>Cancelar</button>
       <button class="btn btn-primary" id="saveCoupon">Salvar</button>
     </div>`,
    {
      onMount(root) {
        const typeSel = root.querySelector('#kType');
        root.querySelector('#saveCoupon').addEventListener('click', async () => {
          const err = root.querySelector('#kError');
          const type = typeSel.value;
          const code = (coupon?.code || root.querySelector('#kCode').value.trim().toUpperCase()).replace(/\s+/g, '');
          const value = type === 'percent' ? Number(root.querySelector('#kValue').value) : toCents(root.querySelector('#kValue').value);
          if (!code || code.length < 3) { err.textContent = 'Código com pelo menos 3 caracteres.'; return; }
          if (!value || value <= 0) { err.textContent = 'Informe o desconto.'; return; }
          if (type === 'percent' && value > 100) { err.textContent = 'Percentual máximo: 100.'; return; }
          const body = {
            code, type, value,
            min_total: toCents(root.querySelector('#kMin').value),
            max_uses: Number(root.querySelector('#kMax').value) || 0,
            expires_at: root.querySelector('#kExp').value || null,
            active: root.querySelector('#kActive').checked,
          };
          try {
            if (coupon) await api(`/api/admin/coupons/${coupon.code}`, { method: 'PUT', auth: true, body });
            else await api('/api/admin/coupons', { method: 'POST', auth: true, body });
            closeModal();
            toast('Cupom salvo.', 'success');
            renderCoupons();
          } catch (ex) { err.textContent = ex.message; }
        });
      },
    }
  );
}

// ================================================================ RELATÓRIOS
async function renderReports() {
  state.reportDays = state.reportDays || 7;
  const days = state.reportDays;
  const stats = await api('/api/admin/stats', { auth: true, params: { days } });
  const { series, topProducts, today } = stats;
  const totalRevenue = series.reduce((a, d) => a + d.revenue, 0);
  const totalOrders = series.reduce((a, d) => a + d.orders, 0);
  const maxRev = Math.max(...series.map((s) => s.revenue), 1);
  const maxQty = Math.max(...topProducts.map((p) => p.qty), 1);
  const typeTotal = Object.values(today.byType).reduce((a, b) => a + b, 0) || 1;
  const payTotal = Object.values(today.byPayment).reduce((a, b) => a + b, 0) || 1;

  $('#view').innerHTML = `
    <div class="row wrap">
      <div class="tabs">
        <button class="tab ${days === 7 ? 'active' : ''}" data-days="7">Últimos 7 dias</button>
        <button class="tab ${days === 30 ? 'active' : ''}" data-days="30">Últimos 30 dias</button>
      </div>
      <button class="btn btn-sm" style="margin-left:auto" id="exportCsv">⬇ Exportar CSV</button>
      <button class="btn btn-sm btn-ghost" id="printReport">🖨 Imprimir</button>
    </div>

    <div class="kpi-grid">
      <div class="kpi brand"><div class="kpi-ico">💰</div>
        <div class="kpi-label">Faturamento (${days}d)</div><div class="kpi-value">${money(totalRevenue)}</div>
        <div class="kpi-foot">${money(today.revenue)} só hoje</div></div>
      <div class="kpi"><div class="kpi-ico">🧾</div>
        <div class="kpi-label">Pedidos (${days}d)</div><div class="kpi-value">${totalOrders}</div>
        <div class="kpi-foot">${today.orders} hoje</div></div>
      <div class="kpi"><div class="kpi-ico">🎯</div>
        <div class="kpi-label">Ticket médio</div><div class="kpi-value">${money(totalOrders ? totalRevenue / totalOrders : 0)}</div>
        <div class="kpi-foot">no período</div></div>
      <div class="kpi green"><div class="kpi-ico">🍔</div>
        <div class="kpi-label">Itens vendidos</div><div class="kpi-value">${topProducts.reduce((a, p) => a + p.qty, 0)}</div>
        <div class="kpi-foot">${today.items} hoje</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3 class="card-title">Faturamento por dia</h3></div>
      <div class="chart">
        ${series
          .map(
            (d, i) => `<div class="chart-col">
              <div class="chart-bar-wrap">
                <div class="chart-bar ${i === series.length - 1 ? 'today' : ''}" style="height:${Math.max(3, (d.revenue / maxRev) * 100)}%">
                  <span class="tip">${money(d.revenue)} · ${d.orders} ped.</span>
                </div>
              </div>
              <span class="chart-label">${d.label}</span>
            </div>`
          )
          .join('')}
      </div>
    </div>

    <div class="grid-2col">
      <div class="card">
        <div class="card-head"><h3 class="card-title">Produtos mais vendidos</h3><span class="tiny muted">${days} dias</span></div>
        ${topProducts.length
          ? `<div class="list">${topProducts
              .map(
                (p, i) => `<div class="list-row">
                  <span class="rank ${i === 0 ? 'top' : ''}">${i + 1}</span>
                  <div class="grow">
                    <div class="between"><strong class="small">${esc(p.name)}</strong>
                      <span class="tiny muted">${p.qty}× · ${money(p.revenue)}</span></div>
                    <div class="bar-mini"><i style="width:${(p.qty / maxQty) * 100}%"></i></div>
                  </div>
                </div>`
              )
              .join('')}</div>`
          : `<div class="empty"><span class="emoji">📉</span><p>Sem dados no período.</p></div>`}
      </div>

      <div class="stack" style="gap:14px">
        <div class="card">
          <div class="card-head"><h3 class="card-title">Hoje por tipo de venda</h3></div>
          <div class="list">
            ${['delivery', 'pickup', 'dinein', 'pos']
              .map((t) => {
                const v = today.byType[t] || 0;
                return `<div class="list-row">
                  <span>${TYPE_ICON[t]}</span>
                  <div class="grow">
                    <div class="between"><strong class="small">${TYPE_LABEL[t]}</strong><span class="tiny muted">${money(v)}</span></div>
                    <div class="bar-mini"><i style="width:${(v / typeTotal) * 100}%"></i></div>
                  </div>
                </div>`;
              })
              .join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3 class="card-title">Hoje por pagamento</h3></div>
          <div class="list">
            ${['pix', 'card', 'cash']
              .map((p) => {
                const v = today.byPayment[p] || 0;
                return `<div class="list-row">
                  <span>${p === 'pix' ? '💠' : p === 'card' ? '💳' : '💵'}</span>
                  <div class="grow">
                    <div class="between"><strong class="small">${PAYMENT_LABEL[p]}</strong><span class="tiny muted">${money(v)}</span></div>
                    <div class="bar-mini"><i style="width:${(v / payTotal) * 100}%"></i></div>
                  </div>
                </div>`;
              })
              .join('')}
          </div>
        </div>
      </div>
    </div>`;

  $$('[data-days]').forEach((b) =>
    b.addEventListener('click', () => {
      state.reportDays = Number(b.dataset.days);
      renderReports();
    })
  );

  $('#exportCsv').addEventListener('click', () => {
    const rows = [['data', 'pedidos', 'faturamento_reais'], ...series.map((d) => [d.date, d.orders, (d.revenue / 100).toFixed(2)])];
    const csv = rows.map((r) => r.join(';')).join('\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `faturamento-${days}dias.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('CSV exportado.', 'success');
  });

  $('#printReport').addEventListener('click', () => window.print());
}

// ================================================================ EQUIPE
async function renderTeam() {
  if (state.user.role !== 'admin') {
    $('#view').innerHTML = `<div class="alert alert-warn">Somente administradores podem gerenciar a equipe.</div>`;
    return;
  }
  const { users } = await api('/api/admin/users', { auth: true });

  $('#view').innerHTML = `
    <div class="row wrap">
      <p class="muted small">Defina quem acessa o painel e o que cada um pode fazer.</p>
      <button class="btn btn-sm btn-primary" style="margin-left:auto" id="addUser">+ Novo usuário</button>
    </div>

    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Função</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${users
            .map(
              (u) => `<tr>
                <td><strong>${esc(u.name)}</strong>${u.id === state.user.id ? ' <span class="badge badge-confirmed">você</span>' : ''}</td>
                <td class="muted">${esc(u.email)}</td>
                <td class="muted">${esc(u.phone || '—')}</td>
                <td><span class="badge badge-completed">${ROLE_LABEL[u.role] || u.role}</span></td>
                <td><span class="badge ${u.active ? 'badge-ready' : 'badge-cancelled'}">${u.active ? 'Ativo' : 'Inativo'}</span></td>
                <td><div class="prod-actions" style="justify-content:flex-end">
                  <button class="btn btn-sm btn-ghost" data-uedit="${u.id}">✎</button>
                  ${u.id !== state.user.id ? `<button class="btn btn-sm btn-danger" data-udel="${u.id}">✕</button>` : ''}
                </div></td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3 class="card-title mb-2">Permissões</h3>
      <div class="list small">
        <div class="list-row"><strong style="min-width:110px">Administrador</strong><span class="muted">Acesso total, incluindo equipe e configurações.</span></div>
        <div class="list-row"><strong style="min-width:110px">Gerente</strong><span class="muted">Pedidos, PDV, cardápio, cupons, relatórios e configurações da loja.</span></div>
        <div class="list-row"><strong style="min-width:110px">Caixa</strong><span class="muted">Pedidos, PDV, mesas e relatórios.</span></div>
        <div class="list-row"><strong style="min-width:110px">Cozinha</strong><span class="muted">Somente pedidos e atualização de status.</span></div>
      </div>
    </div>`;

  $('#addUser').addEventListener('click', () => userForm());
  $$('[data-uedit]').forEach((b) =>
    b.addEventListener('click', () => userForm(users.find((u) => u.id === Number(b.dataset.uedit))))
  );
  $$('[data-udel]').forEach((b) =>
    b.addEventListener('click', async () => {
      const u = users.find((x) => x.id === Number(b.dataset.udel));
      const ok = await confirmDialog({ title: 'Remover usuário', message: `Remover ${u.name}?`, confirmText: 'Remover', danger: true });
      if (!ok) return;
      try {
        await api(`/api/admin/users/${u.id}`, { method: 'DELETE', auth: true });
        toast('Usuário removido.', 'success');
        renderTeam();
      } catch (err) { toast(err.message, 'error'); }
    })
  );
}

function userForm(user = null) {
  const roles = [['admin', 'Administrador'], ['manager', 'Gerente'], ['cashier', 'Caixa'], ['kitchen', 'Cozinha']];
  openModal(
    `<div class="modal-head"><h3>${user ? 'Editar usuário' : 'Novo usuário'}</h3><button class="modal-close" data-close>×</button></div>
     <div class="modal-body">
       <div class="grid-2">
         <div class="field"><label>Nome *</label><input class="input" id="uName" value="${esc(user?.name || '')}" /></div>
         <div class="field"><label>Telefone</label><input class="input" id="uPhone" inputmode="tel" maxlength="16" value="${esc(user?.phone || '')}" /></div>
       </div>
       <div class="field"><label>E-mail *</label><input class="input" id="uEmail" type="email" value="${esc(user?.email || '')}" ${user ? 'disabled' : ''} /></div>
       <div class="grid-2">
         <div class="field"><label>Função</label>
           <select class="select" id="uRole">
             ${roles.map(([v, l]) => `<option value="${v}" ${user?.role === v ? 'selected' : ''}>${l}</option>`).join('')}
           </select>
         </div>
         <div class="field"><label>${user ? 'Nova senha (opcional)' : 'Senha *'}</label>
           <input class="input" id="uPass" type="password" autocomplete="new-password" placeholder="mínimo 6 caracteres" /></div>
       </div>
       <label class="checkbox"><input type="checkbox" id="uActive" ${!user || user.active ? 'checked' : ''} /> Usuário ativo</label>
       <p class="form-error" id="uError"></p>
     </div>
     <div class="modal-foot">
       <button class="btn btn-ghost" data-close>Cancelar</button>
       <button class="btn btn-primary" id="saveUser">Salvar</button>
     </div>`,
    {
      onMount(root) {
        root.querySelector('#saveUser').addEventListener('click', async () => {
          const err = root.querySelector('#uError');
          const body = {
            name: root.querySelector('#uName').value.trim(),
            email: root.querySelector('#uEmail').value.trim().toLowerCase(),
            phone: root.querySelector('#uPhone').value,
            role: root.querySelector('#uRole').value,
            password: root.querySelector('#uPass').value,
            active: root.querySelector('#uActive').checked,
          };
          if (body.name.length < 2) { err.textContent = 'Informe o nome.'; return; }
          if (!user && body.password.length < 6) { err.textContent = 'Senha com pelo menos 6 caracteres.'; return; }
          try {
            if (user) {
              await api(`/api/admin/users/${user.id}`, { method: 'PUT', auth: true, body });
            } else {
              await api('/api/admin/users', { method: 'POST', auth: true, body });
            }
            closeModal();
            toast('Usuário salvo.', 'success');
            renderTeam();
          } catch (ex) { err.textContent = ex.message; }
        });
      },
    }
  );
}

// ================================================================ CONFIGURAÇÕES
async function saveLogo(dataUrl) {
  const { settings } = await api('/api/admin/settings', {
    method: 'PUT', auth: true, body: { logo: dataUrl },
  });
  state.settings = { ...state.settings, logo: settings.logo };
  applyLogo(settings.logo);
  // atualiza a prévia sem recarregar a página inteira
  const preview = document.getElementById('logoPreview');
  if (preview) {
    preview.classList.toggle('has-image', Boolean(settings.logo));
    preview.innerHTML = settings.logo ? `<img src="${settings.logo}" alt="Logo da loja" />` : '<span>🍔</span>';
  }
  document.getElementById('logoRemove')?.classList.toggle('hidden', !settings.logo);
  return settings.logo;
}

const TEXT_FIELDS = {
  banner: [
    ['announcement', 'Faixa do topo', 'Deixe vazio para esconder a faixa laranja'],
    ['store_tagline', 'Subtítulo da marca', 'Aparece embaixo do nome da loja'],
  ],
  hero: [
    ['hero_badge_open', 'Selo quando aberto', 'Ex: Aberto agora'],
    ['hero_badge_closed', 'Selo quando fechado', 'Ex: Fechado no momento'],
    ['hero_title', 'Título — 1ª linha', 'Ex: Comida de verdade,'],
    ['hero_title_highlight', 'Título — 2ª linha (colorida)', 'Ex: feita na brasa.'],
    ['hero_subtitle', 'Frase de apoio', '', 'textarea'],
    ['hero_cta_primary', 'Botão principal', 'Ex: Pedir agora'],
    ['hero_cta_secondary', 'Botão de mesa', 'Ex: Pedir na mesa'],
  ],
  metas: [
    ['hero_meta_1', 'Rótulo 1', 'Ao lado do tempo médio'],
    ['hero_meta_2', 'Rótulo 2', 'Ao lado da taxa de entrega'],
    ['hero_meta_3', 'Rótulo 3', 'Ao lado do frete grátis'],
    ['hero_meta_4', 'Rótulo 4', 'Ao lado do PIX'],
  ],
  benefits: [
    ['benefit_1_icon', 'Ícone 1', 'Um emoji'],
    ['benefit_1_title', 'Título 1'],
    ['benefit_1_text', 'Texto 1'],
    ['benefit_2_icon', 'Ícone 2', 'Um emoji'],
    ['benefit_2_title', 'Título 2'],
    ['benefit_2_text', 'Texto 2', 'Vazio = mostra o frete grátis calculado'],
    ['benefit_3_icon', 'Ícone 3', 'Um emoji'],
    ['benefit_3_title', 'Título 3'],
    ['benefit_3_text', 'Texto 3'],
    ['benefit_4_icon', 'Ícone 4', 'Um emoji'],
    ['benefit_4_title', 'Título 4', 'Vazio = mostra o horário de funcionamento'],
    ['benefit_4_text', 'Texto 4'],
  ],
  menu: [
    ['menu_eyebrow', 'Rótulo acima do título', 'Ex: Cardápio'],
    ['menu_title', 'Título da seção', 'Ex: Escolha o que vai hoje'],
    ['menu_search', 'Texto do campo de busca', 'Ex: Buscar no cardápio...'],
  ],
  how: [
    ['how_eyebrow', 'Rótulo acima do título', 'Ex: Simples assim'],
    ['how_title', 'Título da seção', 'Ex: Três jeitos de pedir'],
    ['how_1_title', 'Card 1 — título'],
    ['how_1_text', 'Card 1 — texto', '', 'textarea'],
    ['how_1_link', 'Card 1 — link'],
    ['how_2_title', 'Card 2 — título'],
    ['how_2_text', 'Card 2 — texto', '', 'textarea'],
    ['how_2_link', 'Card 2 — link'],
    ['how_3_title', 'Card 3 — título'],
    ['how_3_text', 'Card 3 — texto', '', 'textarea'],
    ['how_3_link', 'Card 3 — link'],
  ],
  visit: [
    ['visit_eyebrow', 'Rótulo da seção', 'Ex: Venha nos visitar'],
    ['visit_card_title', 'Título do cartão de contato'],
    ['visit_card_text', 'Texto do cartão de contato'],
    ['visit_whats_btn', 'Botão do WhatsApp'],
    ['visit_track_btn', 'Botão de acompanhar pedido'],
    ['visit_hours_label', 'Rótulo do horário'],
    ['visit_phone_label', 'Rótulo do telefone'],
    ['visit_pix_label', 'Rótulo da chave PIX'],
  ],
  footer: [
    ['footer_note', 'Frase do rodapé', 'Abaixo do nome da loja'],
  ],
};

function textFields(group, current, canEdit) {
  return TEXT_FIELDS[group]
    .map(([key, label, hint, type]) => {
      const value = current[key] ?? '';
      const control = type === 'textarea'
        ? `<textarea class="textarea" id="s_${key}" rows="2" maxlength="240" ${canEdit ? '' : 'disabled'}>${esc(value)}</textarea>`
        : `<input class="input" id="s_${key}" value="${esc(value)}" maxlength="160" ${canEdit ? '' : 'disabled'} />`;
      return `<div class="field">
        <label for="s_${key}">${label}</label>
        ${control}
        ${hint ? `<small class="tiny muted">${hint}</small>` : ''}
      </div>`;
    })
    .join('');
}

function textsCard(settings, canEdit) {
  const groups = [
    ['banner', '🏷️ Faixa e marca', false],
    ['hero', '🌅 Destaque principal', true],
    ['metas', '📊 Indicadores do destaque', false],
    ['benefits', '✨ Vantagens', false],
    ['menu', '🍽️ Seção do cardápio', false],
    ['how', '🚀 Como funciona', false],
    ['visit', '📍 Visita e contato', true],
    ['footer', '🔻 Rodapé', false],
  ];
  return `<div class="card form-section texts-card" id="textsCard">
    <div class="between">
      <div>
        <h3>✍️ Textos do site</h3>
        <p class="tiny muted">Edite cada frase do cardápio. Deixe vazio para usar o texto padrão.</p>
      </div>
      ${canEdit ? '<button class="btn btn-sm" id="resetTexts" title="Volta todos os textos ao padrão">↺ Restaurar padrão</button>' : ''}
    </div>
    ${groups
      .map(
        ([group, title, open]) => `<details class="text-group" ${open ? 'open' : ''}>
          <summary>${title}</summary>
          <div class="text-group-body">${textFields(group, settings, canEdit)}</div>
        </details>`
      )
      .join('')}
  </div>`;
}

async function renderSettings() {
  const { settings } = await api('/api/admin/settings', { auth: true });
  state.settings = settings;
  const canEdit = ['admin', 'manager'].includes(state.user.role);

  const text = (key, label, hint = '', type = 'text') => `
    <div class="field">
      <label for="s_${key}">${label}</label>
      <input class="input" id="s_${key}" type="${type}" value="${esc(settings[key] ?? '')}" ${canEdit ? '' : 'disabled'} />
      ${hint ? `<small class="tiny muted">${hint}</small>` : ''}
    </div>`;
  const moneyField = (key, label, hint = '') => `
    <div class="field">
      <label for="s_${key}">${label}</label>
      <input class="input" id="s_${key}" inputmode="decimal" value="${fromCents(settings[key])}" ${canEdit ? '' : 'disabled'} />
      ${hint ? `<small class="tiny muted">${hint}</small>` : ''}
    </div>`;

  $('#view').innerHTML = `
    <div class="grid-2col">
      <div class="card form-section">
        <h3>🖼️ Identidade visual</h3>
        <div class="logo-editor">
          <div class="logo-preview ${settings.logo ? 'has-image' : ''}" id="logoPreview">
            ${settings.logo ? `<img src="${settings.logo}" alt="Logo da loja" />` : '<span>🍔</span>'}
          </div>
          <div class="logo-info">
            <strong>Logo da loja</strong>
            <p class="tiny muted">Aparece no cardápio, no painel, na tela da cozinha e na aba do navegador.
            PNG, JPG ou WEBP · quadrada fica melhor · a imagem é otimizada automaticamente.</p>
            <div class="row wrap mt-2">
              <input type="file" id="logoInput" accept="image/png,image/jpeg,image/webp" hidden ${canEdit ? '' : 'disabled'} />
              <button class="btn btn-sm btn-primary" id="logoPick" ${canEdit ? '' : 'disabled'}>Escolher imagem</button>
              <button class="btn btn-sm btn-danger ${settings.logo ? '' : 'hidden'}" id="logoRemove" ${canEdit ? '' : 'disabled'}>Remover</button>
              <span class="tiny muted" id="logoStatus"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="card form-section">
        <h3>🏪 Dados da loja</h3>
        ${text('store_name', 'Nome da loja')}
        ${text('store_tagline', 'Slogan / descrição curta')}
        ${text('store_phone', 'Telefone de contato')}
        ${text('whatsapp', 'WhatsApp (só números, com DDI 55)', 'Ex: 5569999990000')}
        ${text('address', 'Endereço')}
        ${text('announcement', 'Faixa de anúncio no topo do site', 'Deixe vazio para esconder')}
      </div>

      <div class="card form-section">
        <h3>🛵 Entrega e pedidos</h3>
        ${moneyField('delivery_fee', 'Taxa de entrega (R$)')}
        ${moneyField('free_delivery_above', 'Frete grátis acima de (R$)', '0 = desativado')}
        ${moneyField('min_order', 'Pedido mínimo para entrega (R$)', '0 = sem mínimo')}
        ${text('avg_prep_time', 'Tempo médio de preparo (min)', '', 'number')}
        ${text('open_hours', 'Horário de funcionamento (texto)')}
        <div class="setting-row">
          <div class="lbl"><strong>Aceitar pedidos online</strong><small>Se desligado, o cardápio fica em modo somente leitura.</small></div>
          <div class="ctl"><label class="switch"><input type="checkbox" id="s_accept_online_orders" ${settings.accept_online_orders === '1' ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /><span></span></label></div>
        </div>
        <div class="setting-row">
          <div class="lbl"><strong>Loja aberta</strong><small>Horário de funcionamento agora.</small></div>
          <div class="ctl"><label class="switch"><input type="checkbox" id="s_open" ${settings.open === '1' ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /><span></span></label></div>
        </div>
      </div>

      ${textsCard(settings, canEdit)}

      <div class="card form-section">
        <h3>💠 PIX</h3>
        ${text('pix_key', 'Chave PIX', 'CPF/CNPJ, e-mail, telefone ou chave aleatória')}
        ${text('pix_holder', 'Nome do recebedor', 'Aparece no comprovante')}
        <div class="alert alert-warn small">
          O sistema gera o código “copia e cola” do PIX com o valor exato do pedido.
          A confirmação do pagamento é manual, feita pelo painel — depois é fácil integrar um
          gateway (Mercado Pago, Asaas etc.) quando você sair do modo teste.
        </div>
      </div>

      <div class="card form-section">
        <h3>⚠️ Área de risco</h3>
        <p class="muted small">Use com cuidado. Estas ações não podem ser desfeitas.</p>
        <div class="row wrap">
          <button class="btn btn-danger btn-sm" id="clearOrders">🧹 Limpar todos os pedidos</button>
        </div>
        <p class="tiny muted">Dica: o banco de dados fica no arquivo <span class="kbd">data/food.db</span>. Faça backup copiando esse arquivo.</p>
        <hr class="divider" />
        <h3>ℹ️ Sobre o sistema</h3>
        <p class="muted small">Sistema Food v1.0 — Node.js + SQLite nativo, sem dependências e sem custo mensal.
        Roda em qualquer PC, notebook ou hospedagem gratuita.</p>
      </div>
    </div>

    ${canEdit ? `<div class="row" style="position:sticky;bottom:14px;justify-content:flex-end">
      <button class="btn btn-primary btn-lg" id="saveSettings">💾 Salvar configurações</button>
    </div>` : ''}`;

  const logoInput = $('#logoInput');
  $('#logoPick')?.addEventListener('click', () => logoInput?.click());
  logoInput?.addEventListener('change', async () => {
    const file = logoInput.files?.[0];
    if (!file) return;
    const status = $('#logoStatus');
    status.innerHTML = '<span class="spinner"></span> Otimizando...';
    try {
      const dataUrl = await imageToDataUrl(file, { maxSize: 400, quality: 0.9 });
      await saveLogo(dataUrl);
      status.textContent = 'Logo atualizada ✓';
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'error');
    } finally {
      logoInput.value = '';
    }
  });

  $('#logoRemove')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Remover logo',
      message: 'A loja volta a usar o ícone padrão. Deseja continuar?',
      confirmText: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await saveLogo('');
      toast('Logo removida.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#saveSettings')?.addEventListener('click', async () => {
    const body = {
      store_name: $('#s_store_name').value,
      store_tagline: $('#s_store_tagline').value,
      store_phone: $('#s_store_phone').value,
      whatsapp: onlyDigits($('#s_whatsapp').value),
      address: $('#s_address').value,
      announcement: $('#s_announcement').value,
      delivery_fee: toCents($('#s_delivery_fee').value),
      free_delivery_above: toCents($('#s_free_delivery_above').value),
      min_order: toCents($('#s_min_order').value),
      avg_prep_time: Number($('#s_avg_prep_time').value) || 30,
      open_hours: $('#s_open_hours').value,
      pix_key: $('#s_pix_key').value,
      pix_holder: $('#s_pix_holder').value,
      accept_online_orders: $('#s_accept_online_orders').checked,
      open: $('#s_open').checked,
    };
    // textos do site (só os campos presentes na tela)
    for (const group of Object.keys(TEXT_FIELDS)) {
      for (const [key] of TEXT_FIELDS[group]) {
        const input = document.getElementById(`s_${key}`);
        if (input) body[key] = input.value;
      }
    }
    try {
      const res = await api('/api/admin/settings', { method: 'PUT', auth: true, body });
      state.settings = res.settings;
      $('#sideStoreName').textContent = res.settings.store_name;
      paintStoreState();
      toast('Configurações salvas!', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#resetTexts')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Restaurar textos',
      message: 'Todos os textos do site voltam ao padrão original. Suas outras configurações não mudam.',
      confirmText: 'Restaurar',
    });
    if (!ok) return;
    try {
      await api('/api/admin/settings/reset-texts', { method: 'POST', auth: true });
      toast('Textos restaurados.', 'success');
      renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#clearOrders')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Limpar histórico',
      message: 'Todos os pedidos e itens serão apagados. Produtos, mesas e usuários permanecem.',
      confirmText: 'Apagar pedidos', danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/admin/clear-orders', { method: 'POST', auth: true, body: { confirm: true } });
      toast('Pedidos apagados.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}
