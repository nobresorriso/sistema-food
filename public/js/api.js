// public/js/api.js — utilitários compartilhados (sem frameworks)
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const TOKEN_KEY = 'sf_token';
const USER_KEY = 'sf_user';

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY) || ''; },
  get user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  },
  set(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, options = {}) {
  const { method = 'GET', body, auth: useAuth = false, params } = options;
  let url = path;
  if (params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if ([...qs].length) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (useAuth || auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && auth.token) {
      auth.clear();
      window.dispatchEvent(new Event('sf:unauthorized'));
    }
    throw new ApiError(data?.error || `Erro ${res.status}`, res.status);
  }
  return data;
}

// ---------------- formatação ----------------
export const money = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const moneyShort = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}
export function timeAgo(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'agora';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  return `${Math.floor(diff / 86400)} d`;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

export function maskPhone(value) {
  const d = onlyDigits(value).slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

// ---------------- status ----------------
export const STATUS_LABEL = {
  pending: 'Aguardando',
  confirmed: 'Confirmado',
  preparing: 'Em preparo',
  ready: 'Pronto',
  out_for_delivery: 'Em entrega',
  completed: 'Concluído',
  cancelled: 'Cancelado',
};
export const TYPE_LABEL = {
  delivery: 'Entrega', pickup: 'Retirada', dinein: 'Mesa', pos: 'Balcão',
};
export const TYPE_ICON = {
  delivery: '🛵', pickup: '🥡', dinein: '🍽️', pos: '🏪',
};
export const PAYMENT_LABEL = { pix: 'PIX', cash: 'Dinheiro', card: 'Cartão' };

export const statusBadge = (status) =>
  `<span class="badge badge-${status} badge-dot">${STATUS_LABEL[status] || status}</span>`;

export const typeBadge = (type) =>
  `<span class="badge badge-completed">${TYPE_ICON[type] || ''} ${TYPE_LABEL[type] || type}</span>`;

// ---------------- UI ----------------
export function toast(message, type = 'info', ms = 3600) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : '🔔';
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icon}</span><span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

let modalEl = null;
export function openModal(html, { onMount, onClose, className = '' } = {}) {
  closeModal();
  modalEl = document.createElement('div');
  modalEl.className = 'modal-backdrop';
  modalEl.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true">${html}</div>`;
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeModal();
  });
  modalEl.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeModal));
  document.body.appendChild(modalEl);
  document.body.style.overflow = 'hidden';
  modalEl._onClose = onClose;
  if (onMount) onMount(modalEl);
  return modalEl;
}
export function closeModal() {
  if (!modalEl) return;
  const cb = modalEl._onClose;
  modalEl.remove();
  modalEl = null;
  document.body.style.overflow = document.querySelector('.drawer.open') ? 'hidden' : '';
  if (cb) cb();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

export function confirmDialog({ title = 'Confirmar', message = '', confirmText = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    openModal(
      `<div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" data-close>×</button></div>
       <div class="modal-body"><p class="muted">${esc(message)}</p></div>
       <div class="modal-foot">
         <button class="btn btn-ghost" data-close>Cancelar</button>
         <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cfm-ok">${esc(confirmText)}</button>
       </div>`,
      {
        onMount(root) {
          root.querySelector('#cfm-ok').addEventListener('click', () => {
            answered = true;
            closeModal();
            resolve(true);
          });
        },
        onClose() { if (!answered) resolve(false); },
      }
    );
  });
}

export function whatsappLink(phone, text) {
  const digits = onlyDigits(phone);
  const withCountry = digits.length <= 11 ? `55${digits}` : digits;
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(text)}`;
}
