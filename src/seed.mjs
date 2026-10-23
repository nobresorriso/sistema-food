// src/seed.mjs — utilidades de banco
//   npm run seed   → popula o banco se estiver vazio
//   npm run reset  → apaga tudo e recria cardápio, usuários, mesas e cupons
//   npm run demo   → gera pedidos de exemplo para visualizar os relatórios
import { db, q, runSeed, resetDatabase, isEmpty, getSettings } from './db.mjs';
import { randomCode } from './util.mjs';

const args = new Set(process.argv.slice(2));

function demoOrders() {
  const products = q.all('SELECT * FROM products WHERE active = 1');
  if (!products.length) {
    console.log('Cardápio vazio. Rode "npm run reset" antes.');
    return;
  }
  const customers = [
    ['Ana Souza', '(69) 99911-2233', 'Rua das Flores, 120 - Centro'],
    ['Bruno Lima', '(69) 99822-3344', 'Av. Rio Madeira, 45 - Flodoaldo Pontes'],
    ['Carla Mendes', '(69) 99733-4455', 'Rua Pio XII, 890 - São Cristóvão'],
    ['Diego Rocha', '(69) 99644-5566', 'Av. Nações Unidas, 2100 - Nova Porto Velho'],
    ['Elisa Ferreira', '(69) 99555-6677', 'Rua México, 78 - Embratel'],
    ['Fábio Nunes', '(69) 99466-7788', 'Av. Jorge Teixeira, 3300 - Industrial'],
    ['Gabriela Alves', '(69) 99377-8899', 'Rua Venezuela, 33 - Centro'],
  ];
  const types = ['delivery', 'delivery', 'delivery', 'pickup', 'dinein', 'pos'];
  const payments = ['pix', 'card', 'cash', 'pix'];
  const tables = q.all('SELECT id FROM tables ORDER BY id');
  const now = Date.now();
  let created = 0;

  const insertOrder = db.prepare(`
    INSERT INTO orders (code, type, status, origin, customer_name, customer_phone, address, table_id,
      subtotal, delivery_fee, discount, total, payment_method, payment_status, created_by, created_at, updated_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, '')`);

  const insertItem = db.prepare(
    'INSERT INTO order_items (order_id, product_id, name, emoji, unit_price, qty, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  // histórico dos últimos 6 dias
  for (let day = 6; day >= 1; day--) {
    const count = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
      const when = new Date(now - day * 864e5);
      when.setHours(18 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 60), 0, 0);
      const [name, phone, address] = customers[Math.floor(Math.random() * customers.length)];
      const type = types[Math.floor(Math.random() * types.length)];
      const items = [];
      const n = 1 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        const p = products[Math.floor(Math.random() * products.length)];
        items.push({ p, qty: 1 + Math.floor(Math.random() * 2) });
      }
      const subtotal = items.reduce((a, it) => a + (it.p.promo_price ?? it.p.price) * it.qty, 0);
      const fee = type === 'delivery' ? 500 : 0;
      const pay = payments[Math.floor(Math.random() * payments.length)];
      const orderId = Number(insertOrder.run(
        randomCode('SF'), type, 'completed', type === 'pos' ? 'pos' : 'online',
        name, phone.replace(/\D/g, ''), type === 'delivery' ? address : '',
        type === 'dinein' ? tables[Math.floor(Math.random() * tables.length)].id : null,
        subtotal, fee, 0, subtotal + fee, pay, 'paid',
        when.toISOString(), when.toISOString()
      ).lastInsertRowid);
      for (const it of items) {
        insertItem.run(orderId, it.p.id, it.p.name, it.p.emoji, it.p.promo_price ?? it.p.price, it.qty, '');
      }
      created++;
    }
  }

  // alguns pedidos ativos agora (para a cozinha e o painel ficarem vivos)
  const active = [
    ['delivery', 'pending', 'pix'],
    ['pickup', 'confirmed', 'card'],
    ['dinein', 'preparing', 'cash'],
    ['delivery', 'preparing', 'pix'],
    ['dinein', 'ready', 'card'],
  ];
  active.forEach(([type, status, pay], idx) => {
    const [name, phone, address] = customers[idx % customers.length];
    const p = products[idx % products.length];
    const p2 = products[(idx + 3) % products.length];
    const subtotal = (p.promo_price ?? p.price) + (p2.promo_price ?? p2.price);
    const fee = type === 'delivery' ? 500 : 0;
    const when = new Date(now - (idx + 1) * 6 * 60000);
    const orderId = Number(insertOrder.run(
      randomCode('SF'), type, status, idx % 2 === 0 ? 'online' : 'pos',
      name, phone.replace(/\D/g, ''), type === 'delivery' ? address : '',
      type === 'dinein' ? tables[idx % tables.length].id : null,
      subtotal, fee, 0, subtotal + fee, pay, pay === 'pix' ? 'unpaid' : 'paid',
      when.toISOString(), when.toISOString()
    ).lastInsertRowid);
    insertItem.run(orderId, p.id, p.name, p.emoji, p.promo_price ?? p.price, 1, idx === 0 ? 'sem cebola' : '');
    insertItem.run(orderId, p2.id, p2.name, p2.emoji, p2.promo_price ?? p2.price, 1, '');
    created++;
  });

  console.log(`✓ ${created} pedidos de exemplo criados.`);
  console.log(`  Loja: ${getSettings().store_name}`);
  console.log('  Abra /admin (admin@sistema.food / admin123) para ver os relatórios.');
}

if (args.has('--reset')) {
  resetDatabase();
  console.log('✓ Banco reiniciado com cardápio, usuários, mesas e cupons de exemplo.');
  console.log('  Admin: admin@sistema.food / admin123');
  console.log('  Caixa: caixa@sistema.food / caixa123');
} else if (args.has('--demo')) {
  demoOrders();
} else if (isEmpty()) {
  runSeed();
  console.log('✓ Banco populado com o cardápio inicial.');
} else {
  console.log('Banco já possui dados. Use "npm run reset" para reiniciar ou "npm run demo" para criar pedidos de exemplo.');
}
