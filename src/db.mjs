// src/db.mjs — Banco de dados local (SQLite nativo do Node) + seed do cardápio
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Fuso horário local do restaurante (usado em relatórios e datas)
process.env.TZ = process.env.TZ || 'America/Porto_Velho';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_FILE = path.join(DATA_DIR, 'food.db');
export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ---------- helpers ----------
export const q = {
  run(sql, ...params) {
    return db.prepare(sql).run(...params);
  },
  get(sql, ...params) {
    return db.prepare(sql).get(...params);
  },
  all(sql, ...params) {
    return db.prepare(sql).all(...params);
  },
  pluck(sql, ...params) {
    const row = db.prepare(sql).get(...params);
    return row ? Object.values(row)[0] : undefined;
  },
};

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- schema ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',  -- admin | manager | cashier | kitchen | customer
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '🍽️',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price INTEGER NOT NULL,             -- em centavos
  promo_price INTEGER,                -- preço promocional opcional (centavos)
  image TEXT DEFAULT '',
  emoji TEXT DEFAULT '🍔',
  prep_time INTEGER DEFAULT 20,       -- minutos
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  seats INTEGER DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'free'  -- free | occupied
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,                  -- delivery | pickup | dinein | pos
  status TEXT NOT NULL DEFAULT 'pending',
  origin TEXT NOT NULL DEFAULT 'online', -- online | pos
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
  subtotal INTEGER NOT NULL DEFAULT 0,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  coupon TEXT DEFAULT '',
  payment_method TEXT DEFAULT 'pix',  -- pix | cash | card
  payment_status TEXT NOT NULL DEFAULT 'unpaid', -- unpaid | paid
  change_for INTEGER,
  notes TEXT DEFAULT '',
  cancel_reason TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '',
  unit_price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'percent', -- percent | fixed
  value INTEGER NOT NULL,
  min_total INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,  -- 0 = ilimitado
  uses INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

db.exec(SCHEMA);
db.exec('PRAGMA user_version = 1');

// Migrações leves para bancos criados em versões anteriores
function ensureColumn(table, column, definition) {
  const cols = q.all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('orders', 'origin', "TEXT NOT NULL DEFAULT 'online'");
ensureColumn('orders', 'cancel_reason', "TEXT DEFAULT ''");
ensureColumn('products', 'promo_price', 'INTEGER');

// ---------- settings ----------
export const DEFAULT_SETTINGS = {
  store_name: 'Brasa Burger & Pizza',
  store_tagline: 'Hambúrgueres artesanais, pizzas e porções',
  store_phone: '(69) 99999-0000',
  whatsapp: '5569999990000',
  address: 'Av. Governador Jorge Teixeira, 3200 - Centro, Porto Velho/RO',
  pix_key: 'brasaburger@exemplo.com',
  pix_holder: 'Brasa Burger & Pizza LTDA',
  open: '1',
  open_hours: 'Terça a Domingo · 18h às 23h30',
  delivery_fee: '500',
  free_delivery_above: '8000',
  min_order: '2000',
  avg_prep_time: '35',
  announcement: 'Entrega grátis acima de R$ 80,00 🛵',
  accept_online_orders: '1',
  service_fee_pct: '0',
};

function seedSettings() {
  const set = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) set.run(k, v);
}
seedSettings();

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of q.all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

export function setSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) stmt.run(k, String(v));
  }
}

// ---------- seed ----------
const MENU = [
  {
    name: 'Burgers',
    emoji: '🍔',
    products: [
      { name: 'X-Burger Clássico', description: 'Blend 160g, queijo cheddar, alface, tomate e molho da casa.', price: 2890, emoji: '🍔', prep: 20 },
      { name: 'X-Bacon', description: 'Blend 160g, cheddar duplo, bacon crocante e cebola caramelizada.', price: 3490, emoji: '🥓', prep: 22 },
      { name: 'Smash Duplo', description: 'Dois smash de 90g, queijo prato derretido, picles e mostarda.', price: 3790, emoji: '🍔', prep: 20 },
      { name: 'X-Tudo da Casa', description: 'Blend 180g, presunto, bacon, ovo, cheddar, salada e batata palha.', price: 4290, emoji: '🍔', prep: 25 },
      { name: 'Veggie Burger', description: 'Hambúrguer de grão-de-bico, queijo coalho, rúcula e maionese de ervas.', price: 2990, emoji: '🥬', prep: 22 },
    ],
  },
  {
    name: 'Pizzas',
    emoji: '🍕',
    products: [
      { name: 'Pizza Calabresa', description: 'Molho de tomate, mussarela, calabresa fatiada e cebola. 8 fatias.', price: 4590, emoji: '🍕', prep: 30 },
      { name: 'Pizza Marguerita', description: 'Molho de tomate, mussarela, tomate fresco e manjericão. 8 fatias.', price: 4290, emoji: '🍕', prep: 30 },
      { name: 'Pizza Frango c/ Catupiry', description: 'Frango desfiado, catupiry original e orégano. 8 fatias.', price: 4890, emoji: '🍕', prep: 32 },
      { name: 'Pizza Quatro Queijos', description: 'Mussarela, provolone, gorgonzola e parmesão. 8 fatias.', price: 5190, emoji: '🧀', prep: 32 },
    ],
  },
  {
    name: 'Porções',
    emoji: '🍟',
    products: [
      { name: 'Batata Frita Média', description: '400g de batata crocante com sal e orégano. Serve 2 pessoas.', price: 1890, emoji: '🍟', prep: 15 },
      { name: 'Frango a Passarinho', description: '500g de frango temperado e frito, com alho e limão.', price: 3290, emoji: '🍗', prep: 25 },
      { name: 'Calabresa Acebolada', description: 'Calabresa fatiada na chapa com cebola e pão de alho.', price: 2790, emoji: '🌭', prep: 20 },
      { name: 'Onion Rings', description: 'Anéis de cebola empanados com molho barbecue.', price: 2190, emoji: '🧅', prep: 18 },
    ],
  },
  {
    name: 'Bebidas',
    emoji: '🥤',
    products: [
      { name: 'Coca-Cola Lata 350ml', description: 'Gelada.', price: 690, emoji: '🥤', prep: 2 },
      { name: 'Guaraná Antarctica 350ml', description: 'Gelado.', price: 650, emoji: '🥤', prep: 2 },
      { name: 'Suco de Laranja 500ml', description: 'Natural, feito na hora.', price: 990, emoji: '🍊', prep: 5 },
      { name: 'Água Mineral 500ml', description: 'Com ou sem gás.', price: 400, emoji: '💧', prep: 1 },
      { name: 'Cerveja Heineken Long Neck', description: '330ml, bem gelada. Venda para maiores de 18 anos.', price: 1190, emoji: '🍺', prep: 2 },
    ],
  },
  {
    name: 'Sobremesas',
    emoji: '🍨',
    products: [
      { name: 'Açaí 500ml', description: 'Açaí cremoso com granola, banana e leite condensado.', price: 1690, emoji: '🍧', prep: 10 },
      { name: 'Petit Gateau', description: 'Bolo quente de chocolate com sorvete de creme.', price: 1890, emoji: '🍫', prep: 15 },
      { name: 'Pudim de Leite', description: 'Fatia generosa de pudim caseiro com calda.', price: 990, emoji: '🍮', prep: 5 },
    ],
  },
];

function seedMenu() {
  const now = new Date().toISOString();
  const catStmt = db.prepare('INSERT INTO categories(name, emoji, sort) VALUES (?, ?, ?)');
  const prodStmt = db.prepare(
    `INSERT INTO products(category_id, name, description, price, emoji, prep_time, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  );
  MENU.forEach((cat, i) => {
    const catId = catStmt.run(cat.name, cat.emoji, i).lastInsertRowid;
    for (const p of cat.products) {
      prodStmt.run(catId, p.name, p.description, p.price, p.emoji, p.prep, now);
    }
  });
}

function seedUsers() {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO users(name, email, phone, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  );
  stmt.run('Administrador', 'admin@sistema.food', '(69) 99999-0001', hashPassword('admin123'), 'admin', now);
  stmt.run('Maria Caixa', 'caixa@sistema.food', '(69) 99999-0002', hashPassword('caixa123'), 'cashier', now);
  stmt.run('João Cozinha', 'cozinha@sistema.food', '(69) 99999-0003', hashPassword('cozinha123'), 'kitchen', now);
  stmt.run('Cliente Demo', 'cliente@teste.com', '(69) 98888-7777', hashPassword('cliente123'), 'customer', now);
}

function seedTables() {
  const stmt = db.prepare('INSERT INTO tables(name, seats, status) VALUES (?, ?, ?)');
  for (let i = 1; i <= 10; i++) stmt.run(`Mesa ${String(i).padStart(2, '0')}`, i <= 6 ? 4 : 6, 'free');
}

function seedCoupons() {
  const stmt = db.prepare(
    'INSERT INTO coupons(code, type, value, min_total, max_uses, uses, active) VALUES (?, ?, ?, ?, ?, 0, 1)'
  );
  stmt.run('BEMVINDO10', 'percent', 10, 3000, 0);
  stmt.run('FRETEGRATIS', 'fixed', 500, 5000, 0);
  stmt.run('BRASA15', 'percent', 15, 6000, 100);
}

export function isEmpty() {
  return q.pluck('SELECT COUNT(*) FROM products') === 0;
}

export function runSeed({ force = false } = {}) {
  if (!force && !isEmpty()) return false;
  if (force) {
    db.exec(`
      DELETE FROM order_items; DELETE FROM orders; DELETE FROM products; DELETE FROM categories;
      DELETE FROM coupons; DELETE FROM sessions; DELETE FROM users;
      DELETE FROM sqlite_sequence WHERE name IN ('orders','order_items','products','categories','users','tables');
    `);
  }
  seedMenu();
  seedUsers();
  seedTables();
  seedCoupons();
  return true;
}

// Só popula na primeira execução (mantém dados após reiniciar o servidor)
if (isEmpty()) runSeed();

export function resetDatabase() {
  db.exec(`
    DELETE FROM order_items; DELETE FROM orders; DELETE FROM products; DELETE FROM categories;
    DELETE FROM coupons; DELETE FROM sessions; DELETE FROM users; DELETE FROM tables;
    DELETE FROM sqlite_sequence WHERE name IN ('orders','order_items','products','categories','users','tables');
  `);
  seedMenu();
  seedUsers();
  seedTables();
  seedCoupons();
  setSettings(DEFAULT_SETTINGS);
}
