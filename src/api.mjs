// src/api.mjs — API REST do sistema (zero dependências)
import crypto from 'node:crypto';
import { db, q, getSettings, setSettings, hashPassword, verifyPassword, DEFAULT_SETTINGS } from './db.mjs';
import {
  HttpError, nowISO, localDayStart, randomCode, clean, ORDER_STATUS,
  STATUS_LABEL, TYPE_LABEL, PAYMENT_LABEL,
} from './util.mjs';
import { buildPixPayload } from './pix.mjs';

// ---------------------------------------------------------------- router
const routes = [];

function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '/?$'
  );
  routes.push({ method, regex, keys, handler, ...opts });
}

export function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { ...r, params };
    }
  }
  return null;
}

// ---------------------------------------------------------------- auth
const SESSION_DAYS = 30;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 864e5);
  q.run('DELETE FROM sessions WHERE expires_at < ?', now.toISOString());
  q.run('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    token, userId, now.toISOString(), expires.toISOString());
  return token;
}

function userFromToken(token) {
  if (!token) return null;
  const row = q.get(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    token
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (!row.active) return null;
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, role: row.role };
}

export function requestUser(req) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    const url = new URL(req.url, 'http://x');
    token = url.searchParams.get('token');
  }
  return { token, user: userFromToken(token) };
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role };
}

const STAFF = ['admin', 'manager', 'cashier', 'kitchen'];
const MANAGE = ['admin', 'manager'];

// ---------------------------------------------------------------- helpers
function digits(v) {
  return String(v || '').replace(/\D/g, '').slice(0, 15);
}

function publicSettings() {
  const s = getSettings();
  return {
    store_name: s.store_name,
    store_tagline: s.store_tagline,
    store_phone: s.store_phone,
    whatsapp: s.whatsapp,
    address: s.address,
    open: s.open === '1',
    open_hours: s.open_hours,
    delivery_fee: Number(s.delivery_fee) || 0,
    free_delivery_above: Number(s.free_delivery_above) || 0,
    min_order: Number(s.min_order) || 0,
    avg_prep_time: Number(s.avg_prep_time) || 0,
    announcement: s.announcement,
    pix_key: s.pix_key,
    pix_holder: s.pix_holder,
    logo: s.logo || '',
  };
}

function orderWithItems(order) {
  const items = q.all(
    'SELECT id, product_id, name, emoji, unit_price, qty, notes FROM order_items WHERE order_id = ? ORDER BY id',
    order.id
  );
  const table = order.table_id
    ? q.get('SELECT name FROM tables WHERE id = ?', order.table_id)
    : null;
  const out = { ...order, items, table_name: table ? table.name : null };
  if (order.payment_method === 'pix' && order.payment_status === 'unpaid' && order.status !== 'cancelled') {
    const s = getSettings();
    out.pix = {
      payload: buildPixPayload({
        key: s.pix_key,
        holder: s.pix_holder,
        amountCents: order.total,
        txid: order.code,
      }),
      key: s.pix_key,
      holder: s.pix_holder,
    };
  }
  return out;
}

function getOrder(id) {
  const order = q.get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  return orderWithItems(order);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

const sseClients = new Set();

// ---------------------------------------------------------------- validação
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseItems(rawItems, { staff = false } = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, 'Adicione pelo menos um item ao pedido.');
  }
  if (rawItems.length > 60) throw new HttpError(400, 'Pedido com itens demais.');

  const merged = [];
  for (const item of rawItems) {
    const id = num(item.product_id ?? item.productId);
    const qty = num(item.qty ?? 1);
    if (!id) throw new HttpError(400, 'Item inválido no pedido.');
    if (qty < 1 || qty > 99) throw new HttpError(400, 'Quantidade inválida.');
    const product = q.get('SELECT * FROM products WHERE id = ?', id);
    if (!product) throw new HttpError(400, 'Produto não encontrado no cardápio.');
    if (!product.active && !staff) throw new HttpError(400, `"${product.name}" não está disponível.`);
    const unit = product.promo_price ?? product.price;
    const note = clean(item.notes, 140);
    const key = `${id}|${note}`;
    const existing = merged.find((m) => m.key === key);
    if (existing) existing.qty = Math.min(99, existing.qty + qty);
    else {
      merged.push({
        key,
        product_id: product.id,
        name: product.name,
        emoji: product.emoji,
        unit_price: unit,
        qty,
        notes: note,
        prep: product.prep_time || 20,
      });
    }
  }
  return merged;
}

function cartTotals(items, settings) {
  const subtotal = items.reduce((acc, i) => acc + i.unit_price * i.qty, 0);
  const prep = items.reduce((acc, i) => Math.max(acc, i.prep || 0), 0);
  return { subtotal, prep };
}

function applyCoupon(codeRaw, subtotal) {
  const code = clean(codeRaw, 30).toUpperCase().replace(/\s+/g, '');
  if (!code) return { coupon: null, discount: 0 };
  const coupon = q.get('SELECT * FROM coupons WHERE code = ?', code);
  if (!coupon || !coupon.active) throw new HttpError(400, 'Cupom inválido ou expirado.');
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    throw new HttpError(400, 'Este cupom expirou.');
  }
  if (coupon.max_uses > 0 && coupon.uses >= coupon.max_uses) {
    throw new HttpError(400, 'Este cupom já atingiu o limite de usos.');
  }
  if (subtotal < coupon.min_total) {
    throw new HttpError(400, `Cupom válido para pedidos acima de ${(coupon.min_total / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`);
  }
  const discount = coupon.type === 'percent'
    ? Math.round((subtotal * coupon.value) / 100)
    : Math.min(coupon.value, subtotal);
  return { coupon: coupon.code, discount };
}

function deliveryFeeFor(subtotal, settings) {
  const fee = Number(settings.delivery_fee) || 0;
  const freeAbove = Number(settings.free_delivery_above) || 0;
  if (freeAbove > 0 && subtotal >= freeAbove) return 0;
  return fee;
}

function buildAddress(input) {
  if (!input) return '';
  if (typeof input === 'string') return clean(input, 240);
  const street = clean(input.street, 120);
  const number = clean(input.number, 20);
  const district = clean(input.district, 80);
  const complement = clean(input.complement, 80);
  const reference = clean(input.reference, 120);
  if (!street || !number) return '';
  return [ `${street}, ${number}`, district, complement, reference ? `Ref: ${reference}` : '' ]
    .filter(Boolean)
    .join(' - ')
    .slice(0, 240);
}

function createOrder({ body, user, staff = false }) {
  const settings = getSettings();
  const type = String(body.type || 'delivery');
  if (!['delivery', 'pickup', 'dinein', 'pos'].includes(type)) {
    throw new HttpError(400, 'Tipo de pedido inválido.');
  }
  if (!staff) {
    if (settings.open !== '1') throw new HttpError(400, 'A loja está fechada no momento.');
    if (settings.accept_online_orders !== '1') throw new HttpError(400, 'Não estamos aceitando pedidos online agora.');
  }

  const items = parseItems(body.items, { staff });
  const { subtotal, prep } = cartTotals(items, settings);

  const customerName = clean(body.customer_name ?? body.customer?.name, 80) ||
    (type === 'pos' ? 'Cliente balcão' : '');
  if (customerName.length < 2) throw new HttpError(400, 'Informe seu nome.');
  const phone = digits(body.customer_phone ?? body.customer?.phone);
  if (!staff && type === 'delivery' && phone.length < 10) {
    throw new HttpError(400, 'Informe um telefone/WhatsApp válido para a entrega.');
  }

  const address = buildAddress(body.address);
  if (!staff && type === 'delivery' && !address) {
    throw new HttpError(400, 'Informe o endereço completo para entrega.');
  }

  let tableId = body.table_id ? num(body.table_id) : null;
  if (type === 'dinein') {
    if (!tableId) throw new HttpError(400, 'Escolha a mesa para este pedido.');
    const table = q.get('SELECT * FROM tables WHERE id = ?', tableId);
    if (!table) throw new HttpError(400, 'Mesa não encontrada.');
  }
  if (type !== 'dinein') tableId = null;

  const paymentMethod = ['pix', 'cash', 'card'].includes(body.payment_method) ? body.payment_method : 'pix';
  if (!staff && type !== 'delivery' && type !== 'pickup' && paymentMethod === 'cash' && false) {
    // cash é permitido em todos os tipos
  }

  if (!staff && type === 'delivery') {
    const min = Number(settings.min_order) || 0;
    if (subtotal < min) {
      throw new HttpError(400, `Pedido mínimo para entrega: R$ ${(min / 100).toFixed(2).replace('.', ',')}.`);
    }
  }

  const { coupon, discount } = applyCoupon(body.coupon, subtotal);
  const deliveryFee = type === 'delivery' ? deliveryFeeFor(subtotal, settings) : 0;
  const total = Math.max(0, subtotal + deliveryFee - discount);

  let changeFor = body.change_for ? num(body.change_for) : null;
  if (paymentMethod !== 'cash') changeFor = null;

  const status = staff ? 'confirmed' : 'pending';
  const paymentStatus = staff
    ? (paymentMethod === 'pix' ? 'unpaid' : 'paid')
    : 'unpaid';
  const now = nowISO();

  db.exec('BEGIN');
  try {
    let code = randomCode('SF');
    while (q.get('SELECT 1 AS x FROM orders WHERE code = ?', code)) code = randomCode('SF');

    const info = q.run(
      `INSERT INTO orders
        (code, type, status, origin, customer_id, customer_name, customer_phone, address, table_id,
         subtotal, delivery_fee, discount, total, coupon, payment_method, payment_status, change_for,
         notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code, type, status, staff ? 'pos' : 'online',
      user && user.role === 'customer' ? user.id : null,
      customerName, phone, type === 'delivery' ? address : address,
      tableId, subtotal, deliveryFee, discount, total, coupon || '',
      paymentMethod, paymentStatus, changeFor,
      clean(body.notes, 300), staff ? user?.id ?? null : user?.id ?? null, now, now
    );
    const orderId = Number(info.lastInsertRowid);
    const itemStmt = db.prepare(
      'INSERT INTO order_items(order_id, product_id, name, emoji, unit_price, qty, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const it of items) {
      itemStmt.run(orderId, it.product_id, it.name, it.emoji, it.unit_price, it.qty, it.notes);
    }
    if (coupon) q.run('UPDATE coupons SET uses = uses + 1 WHERE code = ?', coupon);
    if (tableId) q.run("UPDATE tables SET status = 'occupied' WHERE id = ?", tableId);
    db.exec('COMMIT');

    const order = getOrder(orderId);
    order.estimated_minutes = (Number(settings.avg_prep_time) || 0) + Math.round(prep / 2);
    broadcast('order:new', { order });
    return order;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------- rotas públicas
route('GET', '/api/menu', () => {
  const settings = getSettings();
  const cats = q.all('SELECT * FROM categories WHERE active = 1 ORDER BY sort, id');
  const products = q.all('SELECT * FROM products WHERE active = 1 ORDER BY id');
  return {
    store: publicSettings(),
    categories: cats
      .map((c) => ({
        id: c.id,
        name: c.name,
        emoji: c.emoji,
        products: products
          .filter((p) => p.category_id === c.id)
          .map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            price: p.price,
            promo_price: p.promo_price,
            emoji: p.emoji,
            image: p.image,
            prep_time: p.prep_time,
          })),
      }))
      .filter((c) => c.products.length > 0),
    tables: q.all('SELECT id, name, seats, status FROM tables ORDER BY id'),
    status: {
      open: settings.open === '1',
      accepting: settings.accept_online_orders === '1',
      hours: settings.open_hours,
    },
  };
});

route('GET', '/api/store', () => ({ store: publicSettings() }));

route('POST', '/api/auth/register', ({ body }) => {
  const name = clean(body.name, 80);
  const email = clean(body.email, 120).toLowerCase();
  const password = String(body.password || '');
  const phone = digits(body.phone);
  if (name.length < 2) throw new HttpError(400, 'Informe seu nome.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'E-mail inválido.');
  if (password.length < 6) throw new HttpError(400, 'A senha precisa ter pelo menos 6 caracteres.');
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) {
    throw new HttpError(409, 'Este e-mail já está cadastrado.');
  }
  const info = q.run(
    "INSERT INTO users(name, email, phone, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 'customer', 1, ?)",
    name, email, phone, hashPassword(password), nowISO()
  );
  const user = q.get('SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid));
  return { token: createSession(user.id), user: publicUser(user) };
}, { status: 201 });

// proteção simples contra tentativa de força bruta (em memória)
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_TRIES = 8;

function loginKey(req, email) {
  const ip = req.socket?.remoteAddress || 'local';
  return `${ip}|${email}`;
}
function loginBlocked(key) {
  const row = loginAttempts.get(key);
  if (!row) return false;
  if (Date.now() - row.at > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return row.count >= LOGIN_MAX_TRIES;
}
function loginFailed(key) {
  const row = loginAttempts.get(key);
  if (!row || Date.now() - row.at > LOGIN_WINDOW_MS) loginAttempts.set(key, { count: 1, at: Date.now() });
  else row.count += 1;
}

route('POST', '/api/auth/login', ({ body, req }) => {
  const email = clean(body.email, 120).toLowerCase();
  const key = loginKey(req, email);
  if (loginBlocked(key)) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
  }
  const user = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) {
    loginFailed(key);
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }
  if (!user.active) throw new HttpError(403, 'Usuário desativado. Fale com o administrador.');
  loginAttempts.delete(key);
  return { token: createSession(user.id), user: publicUser(user) };
});

route('GET', '/api/auth/me', ({ user }) => ({ user: publicUser(user) }), { auth: true });

route('POST', '/api/auth/logout', ({ token }) => {
  if (token) q.run('DELETE FROM sessions WHERE token = ?', token);
  return { ok: true };
});

route('POST', '/api/coupons/validate', ({ body }) => {
  const subtotal = num(body.subtotal);
  const { coupon, discount } = applyCoupon(body.code, subtotal);
  if (!coupon) return { valid: false, discount: 0 };
  return { valid: true, code: coupon, discount };
});

route('POST', '/api/orders', ({ body, user }) => ({ order: createOrder({ body, user }) }), { status: 201 });

route('GET', '/api/orders/track', ({ query }) => {
  const code = clean(query.code, 20).toUpperCase();
  const phone = digits(query.phone);
  const order = q.get('SELECT * FROM orders WHERE code = ?', code);
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  if (order.customer_phone) {
    if (!phone) throw new HttpError(403, 'Informe o telefone usado no pedido.');
    if (phone !== order.customer_phone) throw new HttpError(403, 'Telefone não confere com o pedido.');
  }
  return { order: orderWithItems(order) };
});

route('GET', '/api/orders/:code', ({ params, query }) => {
  const order = q.get('SELECT * FROM orders WHERE code = ?', params.code.toUpperCase());
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  const phone = digits(query.phone);
  if (order.customer_phone) {
    if (!phone) throw new HttpError(403, 'Informe o telefone usado no pedido.');
    if (phone !== order.customer_phone) throw new HttpError(403, 'Telefone não confere com o pedido.');
  }
  return { order: orderWithItems(order) };
});

// ---------------------------------------------------------------- staff: pedidos
route('GET', '/api/admin/orders', ({ query }) => {
  const limit = Math.min(200, Math.max(1, num(query.limit) || 60));
  const where = [];
  const params = [];
  if (query.status && query.status !== 'all') {
    if (query.status === 'active') where.push("status NOT IN ('completed','cancelled')");
    else {
      const list = String(query.status).split(',').filter((s) => ORDER_STATUS.includes(s));
      if (list.length) {
        where.push(`status IN (${list.map(() => '?').join(',')})`);
        params.push(...list);
      }
    }
  }
  if (query.type && query.type !== 'all') {
    where.push('type = ?');
    params.push(query.type);
  }
  if (query.search) {
    where.push('(code LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
    const s = `%${clean(query.search, 60)}%`;
    params.push(s, s, s);
  }
  if (query.today === '1') {
    where.push('created_at >= ?');
    params.push(localDayStart(0).toISOString());
  }
  const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY datetime(created_at) DESC LIMIT ${limit}`;
  const orders = q.all(sql, ...params).map(orderWithItems);
  return { orders };
}, { auth: true, roles: STAFF });

route('GET', '/api/admin/orders/:id', ({ params }) => ({ order: getOrder(num(params.id)) }), { auth: true, roles: STAFF });

route('POST', '/api/admin/orders', ({ body, user }) => {
  const order = createOrder({ body: { ...body, type: body.type || 'pos' }, user, staff: true });
  return { order };
}, { auth: true, roles: ['admin', 'manager', 'cashier'], status: 201 });

route('PATCH', '/api/admin/orders/:id/status', ({ params, body, user }) => {
  const id = num(params.id);
  const order = q.get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  const status = String(body.status || '');
  if (!ORDER_STATUS.includes(status)) throw new HttpError(400, 'Status inválido.');
  if (order.status === 'cancelled') {
    throw new HttpError(400, 'Pedido cancelado não pode ser reaberto.');
  }
  const reason = clean(body.reason, 200);
  const now = nowISO();
  db.exec('BEGIN');
  try {
    q.run('UPDATE orders SET status = ?, updated_at = ?, cancel_reason = ? WHERE id = ?',
      status, now, status === 'cancelled' ? reason : order.cancel_reason || '', id);
    if ((status === 'completed' || status === 'cancelled') && order.table_id) {
      const open = q.pluck(
        "SELECT COUNT(*) FROM orders WHERE table_id = ? AND id <> ? AND status NOT IN ('completed','cancelled')",
        order.table_id, id
      );
      if (open === 0) q.run("UPDATE tables SET status = 'free' WHERE id = ?", order.table_id);
    }
    if (status === 'cancelled') {
      q.run('UPDATE orders SET payment_status = ? WHERE id = ?', 'unpaid', id);
      if (order.coupon) q.run('UPDATE coupons SET uses = MAX(0, uses - 1) WHERE code = ?', order.coupon);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const updated = getOrder(id);
  broadcast('order:update', { order: updated });
  return { order: updated };
}, { auth: true, roles: ['admin', 'manager', 'cashier', 'kitchen'] });

route('PATCH', '/api/admin/orders/:id/payment', ({ params, body }) => {
  const id = num(params.id);
  const order = q.get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  const status = body.payment_status === 'paid' ? 'paid' : 'unpaid';
  q.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', status, nowISO(), id);
  const updated = getOrder(id);
  broadcast('order:update', { order: updated });
  return { order: updated };
}, { auth: true, roles: ['admin', 'manager', 'cashier'] });

route('POST', '/api/admin/orders/:id/cancel', ({ params, body, user }) => {
  const id = num(params.id);
  const order = q.get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  if (['completed', 'cancelled'].includes(order.status)) throw new HttpError(400, 'Pedido já finalizado.');
  if (!['admin', 'manager', 'cashier'].includes(user.role)) throw new HttpError(403, 'Sem permissão.');
  q.run("UPDATE orders SET status = 'cancelled', payment_status = 'unpaid', cancel_reason = ?, updated_at = ? WHERE id = ?",
    clean(body.reason, 200) || 'Cancelado pelo atendimento', nowISO(), id);
  if (order.table_id) {
    const open = q.pluck("SELECT COUNT(*) FROM orders WHERE table_id = ? AND status NOT IN ('completed','cancelled')", order.table_id);
    if (open === 0) q.run("UPDATE tables SET status = 'free' WHERE id = ?", order.table_id);
  }
  const updated = getOrder(id);
  broadcast('order:update', { order: updated });
  return { order: updated };
}, { auth: true, roles: ['admin', 'manager', 'cashier'] });

// ---------------------------------------------------------------- staff: relatórios
route('GET', '/api/admin/stats', ({ query }) => {
  const days = Math.min(30, Math.max(1, num(query.days) || 7));
  const startToday = localDayStart(0).toISOString();
  const start7 = localDayStart(-(days - 1)).toISOString();
  const valid = "status <> 'cancelled'";

  const todayRows = q.all(`SELECT * FROM orders WHERE created_at >= ? AND ${valid}`, startToday);
  const revenue = todayRows.reduce((a, o) => a + o.total, 0);
  const paidRevenue = todayRows.filter((o) => o.payment_status === 'paid').reduce((a, o) => a + o.total, 0);
  const itemsToday = q.pluck(
    `SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= ? AND o.status <> 'cancelled'`,
    startToday
  );

  const byType = {};
  const byPayment = {};
  for (const o of todayRows) {
    byType[o.type] = (byType[o.type] || 0) + o.total;
    byPayment[o.payment_method] = (byPayment[o.payment_method] || 0) + o.total;
  }

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = localDayStart(-i).toISOString();
    const to = localDayStart(-i + 1).toISOString();
    const row = q.get(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue FROM orders
        WHERE created_at >= ? AND created_at < ? AND ${valid}`,
      from, to
    );
    series.push({
      date: from.slice(0, 10),
      label: new Date(from).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      orders: row.orders,
      revenue: row.revenue,
    });
  }

  const topProducts = q.all(
    `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.unit_price) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= ? AND o.status <> 'cancelled'
      GROUP BY oi.name ORDER BY qty DESC LIMIT 6`,
    start7
  );

  const openOrders = q.pluck("SELECT COUNT(*) FROM orders WHERE status NOT IN ('completed','cancelled')");
  const tablesOccupied = q.pluck("SELECT COUNT(*) FROM tables WHERE status = 'occupied'");
  const tablesTotal = q.pluck('SELECT COUNT(*) FROM tables');
  const avgTicket = todayRows.length ? Math.round(revenue / todayRows.length) : 0;
  const pendingOnline = q.pluck("SELECT COUNT(*) FROM orders WHERE origin = 'online' AND status = 'pending'");

  return {
    today: {
      revenue, paidRevenue, orders: todayRows.length, items: itemsToday,
      avgTicket, byType, byPayment,
      delivery: todayRows.filter((o) => o.type === 'delivery').length,
      dinein: todayRows.filter((o) => o.type === 'dinein').length,
      pickup: todayRows.filter((o) => o.type === 'pickup').length,
    },
    openOrders, pendingOnline, tablesOccupied, tablesTotal,
    series, topProducts,
    statusLabels: STATUS_LABEL, typeLabels: TYPE_LABEL, paymentLabels: PAYMENT_LABEL,
  };
}, { auth: true, roles: STAFF });

// ---------------------------------------------------------------- staff: cardápio
route('GET', '/api/admin/products', () => ({
  products: q.all(
    `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id ORDER BY c.sort, p.id`
  ),
  categories: q.all('SELECT * FROM categories ORDER BY sort, id'),
}), { auth: true, roles: STAFF });

function productPayload(body) {
  const name = clean(body.name, 90);
  const price = num(body.price);
  if (name.length < 2) throw new HttpError(400, 'Informe o nome do produto.');
  if (price <= 0) throw new HttpError(400, 'Informe um preço válido.');
  const promo = body.promo_price === '' || body.promo_price == null ? null : num(body.promo_price);
  if (promo !== null && (promo <= 0 || promo >= price)) {
    throw new HttpError(400, 'O preço promocional deve ser menor que o preço normal.');
  }
  return {
    category_id: body.category_id ? num(body.category_id) : null,
    name,
    description: clean(body.description, 400),
    price,
    promo_price: promo,
    emoji: clean(body.emoji, 8) || '🍽️',
    image: clean(body.image, 300),
    prep_time: Math.max(0, num(body.prep_time) || 0),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

route('POST', '/api/admin/products', ({ body }) => {
  const p = productPayload(body);
  const info = q.run(
    `INSERT INTO products(category_id, name, description, price, promo_price, emoji, image, prep_time, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.category_id, p.name, p.description, p.price, p.promo_price, p.emoji, p.image, p.prep_time, p.active, nowISO()
  );
  return { product: q.get('SELECT * FROM products WHERE id = ?', Number(info.lastInsertRowid)) };
}, { auth: true, roles: MANAGE, status: 201 });

route('PUT', '/api/admin/products/:id', ({ params, body }) => {
  const id = num(params.id);
  if (!q.get('SELECT 1 AS x FROM products WHERE id = ?', id)) throw new HttpError(404, 'Produto não encontrado.');
  const p = productPayload(body);
  q.run(
    `UPDATE products SET category_id=?, name=?, description=?, price=?, promo_price=?, emoji=?, image=?, prep_time=?, active=? WHERE id=?`,
    p.category_id, p.name, p.description, p.price, p.promo_price, p.emoji, p.image, p.prep_time, p.active, id
  );
  return { product: q.get('SELECT * FROM products WHERE id = ?', id) };
}, { auth: true, roles: MANAGE });

route('DELETE', '/api/admin/products/:id', ({ params }) => {
  const id = num(params.id);
  const used = q.pluck('SELECT COUNT(*) FROM order_items WHERE product_id = ?', id);
  if (used > 0) {
    q.run('UPDATE products SET active = 0 WHERE id = ?', id);
    return { ok: true, softDeleted: true, message: 'Produto já vendido antes: foi desativado do cardápio.' };
  }
  q.run('DELETE FROM products WHERE id = ?', id);
  return { ok: true };
}, { auth: true, roles: MANAGE });

route('GET', '/api/admin/categories', () => ({
  categories: q.all(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS products
       FROM categories c ORDER BY sort, id`
  ),
}), { auth: true, roles: STAFF });

route('POST', '/api/admin/categories', ({ body }) => {
  const name = clean(body.name, 60);
  if (!name) throw new HttpError(400, 'Informe o nome da categoria.');
  const sort = num(body.sort) || (q.pluck('SELECT COALESCE(MAX(sort),0)+1 FROM categories') || 0);
  const info = q.run('INSERT INTO categories(name, emoji, sort, active) VALUES (?, ?, ?, ?)',
    name, clean(body.emoji, 8) || '🍽️', sort, 1);
  return { category: q.get('SELECT * FROM categories WHERE id = ?', Number(info.lastInsertRowid)) };
}, { auth: true, roles: MANAGE, status: 201 });

route('PUT', '/api/admin/categories/:id', ({ params, body }) => {
  const id = num(params.id);
  q.run('UPDATE categories SET name = ?, emoji = ?, sort = ?, active = ? WHERE id = ?',
    clean(body.name, 60), clean(body.emoji, 8) || '🍽️', num(body.sort),
    body.active === false ? 0 : 1, id);
  return { category: q.get('SELECT * FROM categories WHERE id = ?', id) };
}, { auth: true, roles: MANAGE });

route('DELETE', '/api/admin/categories/:id', ({ params }) => {
  q.run('DELETE FROM categories WHERE id = ?', num(params.id));
  return { ok: true };
}, { auth: true, roles: MANAGE });

// ---------------------------------------------------------------- staff: cupons
route('GET', '/api/admin/coupons', () => ({
  coupons: q.all('SELECT * FROM coupons ORDER BY code'),
}), { auth: true, roles: MANAGE });

route('POST', '/api/admin/coupons', ({ body }) => {
  const code = clean(body.code, 30).toUpperCase().replace(/\s+/g, '');
  if (code.length < 3) throw new HttpError(400, 'Código do cupom muito curto.');
  if (q.get('SELECT 1 AS x FROM coupons WHERE code = ?', code)) throw new HttpError(409, 'Cupom já existe.');
  const type = body.type === 'fixed' ? 'fixed' : 'percent';
  const value = num(body.value);
  if (value <= 0) throw new HttpError(400, 'Valor do cupom inválido.');
  if (type === 'percent' && value > 100) throw new HttpError(400, 'Desconto não pode passar de 100%.');
  q.run('INSERT INTO coupons(code, type, value, min_total, max_uses, uses, active, expires_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)',
    code, type, value, num(body.min_total), num(body.max_uses), body.expires_at || null);
  return { coupon: q.get('SELECT * FROM coupons WHERE code = ?', code) };
}, { auth: true, roles: MANAGE, status: 201 });

route('PUT', '/api/admin/coupons/:code', ({ params, body }) => {
  q.run('UPDATE coupons SET type=?, value=?, min_total=?, max_uses=?, active=?, expires_at=? WHERE code=?',
    body.type === 'fixed' ? 'fixed' : 'percent', num(body.value), num(body.min_total),
    num(body.max_uses), body.active ? 1 : 0, body.expires_at || null, params.code.toUpperCase());
  return { coupon: q.get('SELECT * FROM coupons WHERE code = ?', params.code.toUpperCase()) };
}, { auth: true, roles: MANAGE });

route('DELETE', '/api/admin/coupons/:code', ({ params }) => {
  q.run('DELETE FROM coupons WHERE code = ?', params.code.toUpperCase());
  return { ok: true };
}, { auth: true, roles: MANAGE });

// ---------------------------------------------------------------- staff: mesas
route('GET', '/api/admin/tables', () => {
  const tables = q.all('SELECT * FROM tables ORDER BY id').map((t) => {
    const open = q.get(
      `SELECT id, code, total, status, created_at FROM orders
        WHERE table_id = ? AND status NOT IN ('completed','cancelled') ORDER BY id DESC LIMIT 1`,
      t.id
    );
    return { ...t, open_order: open || null };
  });
  return { tables };
}, { auth: true, roles: STAFF });

route('POST', '/api/admin/tables', ({ body }) => {
  const name = clean(body.name, 40);
  if (!name) throw new HttpError(400, 'Informe o nome da mesa.');
  const info = q.run('INSERT INTO tables(name, seats, status) VALUES (?, ?, ?)', name, num(body.seats) || 4, 'free');
  return { table: q.get('SELECT * FROM tables WHERE id = ?', Number(info.lastInsertRowid)) };
}, { auth: true, roles: MANAGE, status: 201 });

route('PUT', '/api/admin/tables/:id', ({ params, body }) => {
  const id = num(params.id);
  q.run('UPDATE tables SET name = ?, seats = ?, status = ? WHERE id = ?',
    clean(body.name, 40), num(body.seats) || 4, body.status === 'occupied' ? 'occupied' : 'free', id);
  return { table: q.get('SELECT * FROM tables WHERE id = ?', id) };
}, { auth: true, roles: MANAGE });

route('DELETE', '/api/admin/tables/:id', ({ params }) => {
  const id = num(params.id);
  if (q.pluck('SELECT COUNT(*) FROM orders WHERE table_id = ?', id) > 0) {
    throw new HttpError(400, 'Esta mesa possui pedidos no histórico e não pode ser excluída.');
  }
  q.run('DELETE FROM tables WHERE id = ?', id);
  return { ok: true };
}, { auth: true, roles: MANAGE });

// ---------------------------------------------------------------- staff: configurações
route('GET', '/api/admin/settings', () => ({ settings: getSettings() }), { auth: true, roles: STAFF });

route('PUT', '/api/admin/settings', ({ body }) => {
  const patch = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in body) patch[key] = body[key];
  }
  if ('open' in patch) patch.open = patch.open ? '1' : '0';
  if ('accept_online_orders' in patch) patch.accept_online_orders = patch.accept_online_orders ? '1' : '0';

  if ('logo' in patch) {
    const logo = String(patch.logo || '').trim();
    // aceita apenas imagem em data URL (png/jpeg/webp), já redimensionada no navegador
    if (logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
      throw new HttpError(400, 'Formato de logo inválido. Envie uma imagem PNG, JPG ou WEBP.');
    }
    if (logo.length > 400_000) {
      throw new HttpError(400, 'Logo muito grande. Use uma imagem menor que 300 KB.');
    }
    patch.logo = logo;
  }

  setSettings(patch);
  return { settings: getSettings() };
}, { auth: true, roles: MANAGE });

// ---------------------------------------------------------------- staff: equipe
route('GET', '/api/admin/users', () => ({
  users: q.all('SELECT id, name, email, phone, role, active, created_at FROM users ORDER BY id'),
}), { auth: true, roles: MANAGE });

route('POST', '/api/admin/users', ({ body }) => {
  const name = clean(body.name, 80);
  const email = clean(body.email, 120).toLowerCase();
  const role = ['admin', 'manager', 'cashier', 'kitchen'].includes(body.role) ? body.role : 'cashier';
  if (name.length < 2) throw new HttpError(400, 'Informe o nome.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'E-mail inválido.');
  if (String(body.password || '').length < 6) throw new HttpError(400, 'Senha com pelo menos 6 caracteres.');
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new HttpError(409, 'E-mail já cadastrado.');
  const info = q.run(
    'INSERT INTO users(name, email, phone, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    name, email, digits(body.phone), hashPassword(body.password), role, nowISO()
  );
  return { user: publicUser(q.get('SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid))) };
}, { auth: true, roles: ['admin'], status: 201 });

route('PUT', '/api/admin/users/:id', ({ params, body, user }) => {
  const id = num(params.id);
  const target = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  const role = ['admin', 'manager', 'cashier', 'kitchen'].includes(body.role) ? body.role : target.role;
  const active = body.active === false ? 0 : 1;
  if (id === user.id && active === 0) throw new HttpError(400, 'Você não pode desativar seu próprio usuário.');
  q.run('UPDATE users SET name = ?, phone = ?, role = ?, active = ? WHERE id = ?',
    clean(body.name, 80) || target.name, digits(body.phone) || target.phone, role, active, id);
  if (body.password) {
    if (String(body.password).length < 6) throw new HttpError(400, 'Senha com pelo menos 6 caracteres.');
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.password), id);
    q.run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  return { user: publicUser(q.get('SELECT * FROM users WHERE id = ?', id)) };
}, { auth: true, roles: ['admin'] });

route('DELETE', '/api/admin/users/:id', ({ params, user }) => {
  const id = num(params.id);
  if (id === user.id) throw new HttpError(400, 'Você não pode excluir seu próprio usuário.');
  const used = q.pluck('SELECT COUNT(*) FROM orders WHERE created_by = ?', id);
  if (used > 0) {
    q.run('UPDATE users SET active = 0 WHERE id = ?', id);
    return { ok: true, softDeleted: true };
  }
  q.run('DELETE FROM users WHERE id = ?', id);
  return { ok: true };
}, { auth: true, roles: ['admin'] });

// ---------------------------------------------------------------- utilidades
route('POST', '/api/admin/clear-orders', ({ body }) => {
  if (body.confirm !== true) throw new HttpError(400, 'Confirmação necessária.');
  q.run('DELETE FROM order_items');
  q.run('DELETE FROM orders');
  q.run("UPDATE tables SET status = 'free'");
  return { ok: true };
}, { auth: true, roles: ['admin'] });

// ---------------------------------------------------------------- SSE (tempo real)
route('GET', '/api/admin/events', ({ req, res, query }) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ at: nowISO() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}, { auth: true, roles: STAFF });

// ---------------------------------------------------------------- dispatcher
export async function handleApi(req, res, url) {
  const matched = matchRoute(req.method, url.pathname);
  if (!matched) throw new HttpError(404, 'Rota não encontrada.');

  const { user, token } = requestUser(req);
  if (matched.auth && !user) throw new HttpError(401, 'Faça login para continuar.');
  if (matched.roles && !matched.roles.includes(user.role)) {
    throw new HttpError(403, 'Você não tem permissão para esta ação.');
  }

  let body = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    body = await readBody(req);
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const ctx = {
    req, res, url, body, query, user, token,
    params: matched.params,
  };
  const result = await matched.handler(ctx);
  // rotas que já responderam por conta própria (ex.: SSE) não recebem JSON
  if (res.writableEnded || res.headersSent) return undefined;
  return { status: matched.status || 200, body: result === undefined ? { ok: true } : result };
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Requisição muito grande.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

export { getOrder };
