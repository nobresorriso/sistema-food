// public/js/acompanhar.js
import {
  $, api, money, esc, toast, fmtDateTime, maskPhone, onlyDigits, whatsappLink,
  STATUS_LABEL, TYPE_LABEL, TYPE_ICON, PAYMENT_LABEL,
} from './api.js';

const params = new URLSearchParams(location.search);
const state = { code: (params.get('code') || '').toUpperCase(), phone: onlyDigits(params.get('phone') || ''), order: null, timer: null };

const STEPS = {
  delivery: [
    ['pending', 'Pedido recebido', '⏳'],
    ['confirmed', 'Confirmado', '✅'],
    ['preparing', 'Em preparo', '👨‍🍳'],
    ['ready', 'Pronto', '📦'],
    ['out_for_delivery', 'Saiu para entrega', '🛵'],
    ['completed', 'Entregue', '🏁'],
  ],
  pickup: [
    ['pending', 'Pedido recebido', '⏳'],
    ['confirmed', 'Confirmado', '✅'],
    ['preparing', 'Em preparo', '👨‍🍳'],
    ['ready', 'Pronto para retirar', '📦'],
    ['completed', 'Retirado', '🏁'],
  ],
  dinein: [
    ['pending', 'Pedido recebido', '⏳'],
    ['confirmed', 'Confirmado', '✅'],
    ['preparing', 'Em preparo', '👨‍🍳'],
    ['ready', 'Pronto na mesa', '🍽️'],
    ['completed', 'Concluído', '🏁'],
  ],
  pos: [
    ['pending', 'Pedido recebido', '⏳'],
    ['confirmed', 'Confirmado', '✅'],
    ['preparing', 'Em preparo', '👨‍🍳'],
    ['ready', 'Pronto', '📦'],
    ['completed', 'Concluído', '🏁'],
  ],
};

init();

async function init() {
  const phoneInput = $('#phone');
  phoneInput.addEventListener('input', () => { phoneInput.value = maskPhone(phoneInput.value); });
  $('#trackForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#code').value.trim().toUpperCase();
    const phone = onlyDigits(phoneInput.value);
    if (!code) return;
    history.replaceState(null, '', `/acompanhar?code=${encodeURIComponent(code)}${phone ? `&phone=${phone}` : ''}`);
    state.code = code;
    state.phone = phone;
    load();
  });

  $('#code').value = state.code;
  if (state.phone) phoneInput.value = maskPhone(state.phone);

  try {
    const { store } = await api('/api/store');
    document.getElementById('brandName').textContent = store.store_name;
    document.title = `Meu pedido · ${store.store_name}`;
    state.store = store;
  } catch { /* segue */ }

  if (state.code) load();
  else $('#code').focus();
}

async function load() {
  const section = $('#orderSection');
  section.innerHTML = `<div class="card"><div class="row"><span class="spinner"></span><span class="muted">Buscando pedido...</span></div></div>`;
  section.classList.remove('hidden');
  $('#trackError').textContent = '';
  try {
    const { order } = await api(`/api/orders/${encodeURIComponent(state.code)}`, {
      params: { phone: state.phone || undefined },
    });
    state.order = order;
    render(order);
    $('#searchSection').classList.add('compact');
    startPolling();
  } catch (err) {
    section.classList.add('hidden');
    $('#trackError').textContent = err.message;
  }
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(async () => {
    try {
      const { order } = await api(`/api/orders/${encodeURIComponent(state.code)}`, {
        params: { phone: state.phone || undefined },
      });
      if (order.status !== state.order?.status) {
        state.order = order;
        render(order);
        toast(`Status atualizado: ${STATUS_LABEL[order.status]}`, 'info');
      }
    } catch { /* ignora */ }
  }, 12000);
}

function render(order) {
  const steps = STEPS[order.type] || STEPS.pos;
  const cancelled = order.status === 'cancelled';
  const currentIndex = steps.findIndex(([s]) => s === order.status);
  const doneIndex = order.status === 'completed' ? steps.length - 1 : currentIndex;

  const timeline = cancelled
    ? `<div class="alert alert-error">Pedido cancelado${order.cancel_reason ? `: ${esc(order.cancel_reason)}` : '.'}</div>`
    : `<ol class="timeline">
        ${steps
          .map(([status, label, icon], i) => {
            const done = i <= doneIndex;
            const active = i === doneIndex && order.status !== 'completed';
            return `<li class="tl-step ${done ? 'done' : ''} ${active ? 'active' : ''}">
              <span class="tl-dot">${done ? icon : i + 1}</span>
              <div class="tl-body">
                <strong>${label}</strong>
                ${active && i === doneIndex ? '<small class="muted">Etapa atual</small>' : ''}
              </div>
            </li>`;
          })
          .join('')}
      </ol>`;

  const waText = `Olá! Gostaria de falar sobre o pedido ${order.code}.`;

  $('#orderSection').innerHTML = `
    <div class="track-grid">
      <div class="card track-card">
        <div class="between">
          <div>
            <span class="eyebrow">${TYPE_ICON[order.type]} ${TYPE_LABEL[order.type]}</span>
            <h2 style="font-size:22px">Pedido <span class="mono" style="color:var(--brand-2)">${esc(order.code)}</span></h2>
            <p class="muted small mt-1">Feito em ${fmtDateTime(order.created_at)}</p>
          </div>
          <span class="badge badge-${order.status} badge-dot">${STATUS_LABEL[order.status]}</span>
        </div>

        <div class="mt-3">${timeline}</div>

        ${order.status === 'out_for_delivery' ? `<div class="alert alert-info mt-2">🛵 Seu pedido saiu para entrega. Deixe o telefone por perto!</div>` : ''}
        ${order.status === 'ready' && order.type === 'pickup' ? `<div class="alert alert-success mt-2">📦 Seu pedido está pronto! Pode retirar no balcão.</div>` : ''}
        ${order.status === 'ready' && order.type === 'dinein' ? `<div class="alert alert-success mt-2">🍽️ Seu pedido está indo para a ${esc(order.table_name || 'mesa')}.</div>` : ''}

        ${order.pix ? `
          <div class="pix-box mt-2">
            <div class="between mb-2">
              <strong class="small">💠 Pagamento via PIX</strong>
              <span class="badge badge-pending">Aguardando</span>
            </div>
            <div class="pix-code" id="pixCode">${esc(order.pix.payload)}</div>
            <button class="btn btn-sm btn-primary mt-2" id="copyPix">Copiar código PIX</button>
          </div>` : `
          <div class="alert alert-success mt-2">✅ Pagamento ${order.payment_status === 'paid' ? 'confirmado' : 'combinado na entrega'} · ${PAYMENT_LABEL[order.payment_method]}</div>`}
      </div>

      <div class="card">
        <h3 class="card-title mb-2">Resumo</h3>
        <div class="stack" style="gap:9px">
          ${order.items
            .map(
              (i) => `<div class="between small">
                <span>${esc(i.emoji || '')} <strong>${i.qty}×</strong> ${esc(i.name)}${i.notes ? `<br><span class="tiny muted">📝 ${esc(i.notes)}</span>` : ''}</span>
                <span class="nowrap">${money(i.unit_price * i.qty)}</span>
              </div>`
            )
            .join('')}
        </div>
        <hr class="divider mt-2" />
        <div class="totals mt-2" style="margin-bottom:0">
          <div class="line"><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
          ${order.delivery_fee ? `<div class="line"><span>Entrega</span><span>${money(order.delivery_fee)}</span></div>` : ''}
          ${order.discount ? `<div class="line discount"><span>Desconto ${esc(order.coupon || '')}</span><span>− ${money(order.discount)}</span></div>` : ''}
          <div class="line total"><span>Total</span><span>${money(order.total)}</span></div>
        </div>
        <hr class="divider mt-2" />
        <div class="stack small mt-2" style="gap:6px">
          <div class="between"><span class="muted">Cliente</span><span>${esc(order.customer_name)}</span></div>
          ${order.customer_phone ? `<div class="between"><span class="muted">WhatsApp</span><span>${esc(order.customer_phone)}</span></div>` : ''}
          ${order.table_name ? `<div class="between"><span class="muted">Mesa</span><span>${esc(order.table_name)}</span></div>` : ''}
          ${order.address ? `<div><span class="muted">Endereço</span><p class="small">${esc(order.address)}</p></div>` : ''}
          ${order.notes ? `<div><span class="muted">Observações</span><p class="small">${esc(order.notes)}</p></div>` : ''}
        </div>
        <div class="stack mt-3">
          <a class="btn btn-primary btn-block" href="/">Pedir de novo</a>
          ${state.store?.whatsapp ? `<a class="btn btn-ghost btn-block" target="_blank" rel="noopener" href="${whatsappLink(state.store.whatsapp, waText)}">Falar com a loja</a>` : ''}
          <button class="btn btn-ghost btn-block" id="refreshBtn">↻ Atualizar agora</button>
        </div>
      </div>
    </div>`;

  const copy = document.getElementById('copyPix');
  if (copy) {
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(document.getElementById('pixCode').textContent.trim());
        copy.textContent = '✓ Copiado!';
        toast('Código PIX copiado!', 'success');
      } catch { toast('Não foi possível copiar automaticamente.', 'error'); }
    });
  }
  document.getElementById('refreshBtn').addEventListener('click', load);
}
