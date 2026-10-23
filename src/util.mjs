// src/util.mjs
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function nowISO() {
  return new Date().toISOString();
}

/** Início do dia local (fuso do restaurante), deslocado em dias. */
export function localDayStart(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

export function isToday(iso) {
  const d = new Date(iso);
  const start = localDayStart(0).getTime();
  const end = localDayStart(1).getTime();
  return d.getTime() >= start && d.getTime() < end;
}

export function randomCode(prefix = 'SF') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}-${out}`;
}

export const ORDER_STATUS = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
];

export const STATUS_LABEL = {
  pending: 'Aguardando confirmação',
  confirmed: 'Confirmado',
  preparing: 'Em preparo',
  ready: 'Pronto',
  out_for_delivery: 'Saiu para entrega',
  completed: 'Concluído',
  cancelled: 'Cancelado',
};

export const NEXT_STATUS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'completed', 'cancelled'],
  out_for_delivery: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const PAYMENT_LABEL = {
  pix: 'PIX',
  cash: 'Dinheiro',
  card: 'Cartão',
};

export const TYPE_LABEL = {
  delivery: 'Entrega',
  pickup: 'Retirada',
  dinein: 'Mesa',
  pos: 'Balcão',
};

// Sanitização básica de textos vindos do cliente
export function clean(value, max = 300) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

export function money(cents) {
  return (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
}
