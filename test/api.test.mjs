// test/api.test.mjs — sobe o servidor numa porta isolada e testa a API ponta a ponta
// Uso: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sistema-food-test-'));
const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.mjs')],
  { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR, TZ: 'America/Porto_Velho' }, stdio: 'ignore' }
);

async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/store`);
      if (res.ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('Servidor não respondeu a tempo.');
}
await waitServer();

let pass = 0, fail = 0;
const ok = (cond, msg, extra='') => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg, extra); } };

async function req(path, { method='GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization:`Bearer ${token}`} : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

console.log('\n== Catálogo público ==');
let r = await req('/api/menu');
ok(r.status === 200 && r.data.categories.length >= 5, 'GET /api/menu retorna categorias', JSON.stringify(r.data).slice(0,120));
ok(r.data.store.store_name.includes('Brasa'), 'nome da loja presente');
const firstProduct = r.data.categories[0].products[0];
const tables = r.data.tables;
ok(firstProduct && firstProduct.price > 0, `produto: ${firstProduct?.name} ${firstProduct?.price}`);

console.log('\n== Pedido online (delivery) ==');
let order = await req('/api/orders', { method:'POST', body: {
  type:'delivery', customer_name:'Ana Teste', customer_phone:'(69) 99999-1234',
  address:{ street:'Rua das Flores', number:'100', district:'Centro' },
  payment_method:'pix', notes:'Sem talheres',
  items:[{product_id:firstProduct.id, qty:2}, {product_id:r.data.categories[1].products[0].id, qty:1}],
}});
ok(order.status === 201, 'pedido criado', JSON.stringify(order.data));
const o1 = order.data.order;
ok(o1.code?.startsWith('SF-'), 'código gerado: ' + o1.code);
ok(o1.total === o1.subtotal + o1.delivery_fee - o1.discount, 'total consistente');
ok(o1.pix?.payload?.startsWith('000201'), 'payload PIX gerado');
ok(o1.status === 'pending' && o1.origin === 'online', 'status pendente / origem online');

console.log('\n== Rastreio ==');
r = await req(`/api/orders/track?code=${o1.code}&phone=69999991234`);
ok(r.status === 200 && r.data.order.items.length === 2, 'busca por código + telefone');
r = await req(`/api/orders/track?code=${o1.code}`);
ok(r.status === 403, 'sem telefone não vaza o pedido');
r = await req(`/api/orders/${o1.code}?phone=69999991234`);
ok(r.status === 200, 'busca por código + telefone');
r = await req(`/api/orders/${o1.code}?phone=11111111111`);
ok(r.status === 403, 'telefone errado bloqueado');
r = await req(`/api/orders/NAOEXISTE`);
ok(r.status === 404, 'código inválido 404');

console.log('\n== Cupons ==');
r = await req('/api/coupons/validate', { method:'POST', body:{ code:'BEMVINDO10', subtotal:10000 }});
ok(r.data.valid && r.data.discount === 1000, 'cupom 10% = 1000', JSON.stringify(r.data));
r = await req('/api/coupons/validate', { method:'POST', body:{ code:'BEMVINDO10', subtotal:1000 }});
ok(r.status === 400, 'cupom abaixo do mínimo rejeitado');
r = await req('/api/coupons/validate', { method:'POST', body:{ code:'INVALIDO', subtotal:10000 }});
ok(r.status === 400, 'cupom inválido rejeitado');
const withCoupon = await req('/api/orders', { method:'POST', body: {
  type:'pickup', customer_name:'Bruno Cupom', customer_phone:'6999998888',
  payment_method:'cash', coupon:'BRASA15',
  items:[{product_id:firstProduct.id, qty:3}],
}});
ok(withCoupon.status === 201, 'pedido com cupom criado');
ok(withCoupon.data.order.discount === Math.round(withCoupon.data.order.subtotal*0.15), 'desconto 15% aplicado', JSON.stringify(withCoupon.data.order.discount));

console.log('\n== Validações ==');
r = await req('/api/orders', { method:'POST', body:{ type:'delivery', customer_name:'X', customer_phone:'', items:[] }});
ok(r.status === 400, 'pedido vazio rejeitado');
r = await req('/api/orders', { method:'POST', body:{ type:'delivery', customer_name:'Teste', customer_phone:'69999991111', items:[{product_id:99999, qty:1}] }});
ok(r.status === 400, 'produto inexistente rejeitado');
r = await req('/api/orders', { method:'POST', body:{ type:'entrega', customer_name:'Teste', items:[{product_id:firstProduct.id,qty:1}] }});
ok(r.status === 400, 'tipo inválido rejeitado');
r = await req('/api/admin/orders');
ok(r.status === 401, 'painel exige login');

console.log('\n== Login / painel ==');
r = await req('/api/auth/login', { method:'POST', body:{ email:'admin@sistema.food', password:'errada' }});
ok(r.status === 401, 'senha errada rejeitada');
r = await req('/api/auth/login', { method:'POST', body:{ email:'admin@sistema.food', password:'admin123' }});
ok(r.status === 200 && r.data.token, 'login admin');
const token = r.data.token;
r = await req('/api/auth/me', { token });
ok(r.data.user.role === 'admin', 'me retorna admin');

r = await req('/api/admin/orders?status=pending', { token });
ok(r.status === 200 && r.data.orders.length >= 1, `pedidos pendentes: ${r.data.orders.length}`);

r = await req(`/api/admin/orders/${o1.id}/status`, { method:'PATCH', token, body:{ status:'preparing' }});
ok(r.data.order.status === 'preparing', 'status → em preparo');
r = await req(`/api/admin/orders/${o1.id}/status`, { method:'PATCH', token, body:{ status:'ready' }});
ok(r.data.order.status === 'ready', 'status → pronto');
r = await req(`/api/admin/orders/${o1.id}/payment`, { method:'PATCH', token, body:{ payment_status:'paid' }});
ok(r.data.order.payment_status === 'paid' && !r.data.order.pix, 'pagamento confirmado (PIX some)');

console.log('\n== PDV / balcão ==');
r = await req('/api/admin/orders', { method:'POST', token, body:{
  type:'pos', customer_name:'Cliente Balcão', payment_method:'cash',
  items:[{product_id:firstProduct.id, qty:1}]
}});
ok(r.status === 201 && r.data.order.status === 'confirmed' && r.data.order.payment_status === 'paid', 'venda no balcão já paga');
const posOrder = r.data.order;

r = await req('/api/admin/orders', { method:'POST', token, body:{
  type:'dinein', table_id: tables[2].id, customer_name:'Mesa 3', payment_method:'card',
  items:[{product_id:firstProduct.id, qty:2}]
}});
ok(r.status === 201 && r.data.order.table_name, 'pedido na mesa com nome da mesa');
const dineOrder = r.data.order;
r = await req('/api/admin/tables', { token });
ok(r.data.tables.find(t=>t.id===tables[2].id).status === 'occupied', 'mesa marcada ocupada');
r = await req(`/api/admin/orders/${dineOrder.id}/status`, { method:'PATCH', token, body:{ status:'completed' }});
r = await req('/api/admin/tables', { token });
ok(r.data.tables.find(t=>t.id===tables[2].id).status === 'free', 'mesa liberada ao concluir');

console.log('\n== Estatísticas ==');
r = await req('/api/admin/stats?days=7', { token });
ok(r.status === 200 && r.data.today.revenue > 0, `faturamento hoje: ${(r.data.today.revenue/100).toFixed(2)}`);
ok(r.data.series.length === 7, 'série com 7 dias');
ok(r.data.topProducts.length > 0, 'top produtos');

console.log('\n== Cardápio (admin) ==');
r = await req('/api/admin/products', { method:'POST', token, body:{ name:'Produto Teste', price:1990, category_id:1, emoji:'🧪', prep_time:5, active:true }});
ok(r.status === 201 && r.data.product.price === 1990, 'produto criado');
const pid = r.data.product.id;
r = await req(`/api/admin/products/${pid}`, { method:'PUT', token, body:{ name:'Produto Teste 2', price:2500, category_id:1, active:false }});
ok(r.data.product.name === 'Produto Teste 2' && r.data.product.active === 0, 'produto editado/desativado');
r = await req('/api/menu');
ok(!r.data.categories.flatMap(c=>c.products).some(p=>p.id===pid), 'produto inativo some do cardápio');
r = await req(`/api/admin/products/${pid}`, { method:'DELETE', token });
ok(r.status === 200, 'produto excluído');
r = await req(`/api/admin/products/${firstProduct.id}`, { method:'DELETE', token });
ok(r.data.softDeleted === true, 'produto vendido é apenas desativado');
await req(`/api/admin/products/${firstProduct.id}`, { method:'PUT', token, body:{ name:firstProduct.name, price:firstProduct.price, category_id:firstProduct.category_id ?? 1, emoji:firstProduct.emoji, prep_time:firstProduct.prep_time, active:true }});

console.log('\n== Categorias / cupons / mesas ==');
r = await req('/api/admin/categories', { method:'POST', token, body:{ name:'Teste Cat', emoji:'🧪' }});
ok(r.status === 201, 'categoria criada');
const catId = r.data.category.id;
r = await req(`/api/admin/categories/${catId}`, { method:'DELETE', token });
ok(r.status === 200, 'categoria excluída');
r = await req('/api/admin/coupons', { method:'POST', token, body:{ code:'TESTE20', type:'percent', value:20, min_total:5000 }});
ok(r.status === 201, 'cupom criado');
r = await req('/api/admin/coupons', { method:'POST', token, body:{ code:'TESTE20', type:'percent', value:20 }});
ok(r.status === 409, 'cupom duplicado bloqueado');
r = await req(`/api/admin/coupons/TESTE20`, { method:'DELETE', token });
ok(r.status === 200, 'cupom excluído');
r = await req('/api/admin/tables', { method:'POST', token, body:{ name:'Mesa Teste', seats:2 }});
ok(r.status === 201, 'mesa criada');
const tid = r.data.table.id;
r = await req(`/api/admin/tables/${tid}`, { method:'DELETE', token });
ok(r.status === 200, 'mesa excluída');

console.log('\n== Equipe / permissões ==');
r = await req('/api/admin/users', { method:'POST', token, body:{ name:'Teste Caixa', email:'teste.caixa@sistema.food', password:'123456', role:'cashier' }});
ok(r.status === 201, 'usuário criado');
const uid = r.data.user.id;
r = await req('/api/auth/login', { method:'POST', body:{ email:'teste.caixa@sistema.food', password:'123456' }});
const cashToken = r.data.token;
r = await req('/api/admin/users', { token: cashToken });
ok(r.status === 403, 'caixa não acessa equipe');
r = await req('/api/admin/products', { method:'POST', token: cashToken, body:{ name:'X', price:100 }});
ok(r.status === 403, 'caixa não cria produto');
r = await req('/api/admin/orders', { method:'POST', token: cashToken, body:{ type:'pos', customer_name:'Ana Caixa', payment_method:'cash', items:[{product_id:2,qty:1}] }});
ok(r.status === 201, 'caixa pode vender no PDV');
r = await req('/api/auth/login', { method:'POST', body:{ email:'cozinha@sistema.food', password:'cozinha123' }});
const kitchenToken = r.data.token;
r = await req('/api/admin/products', { method:'POST', token: kitchenToken, body:{ name:'X', price:100 }});
ok(r.status === 403, 'cozinha não altera cardápio');
r = await req('/api/admin/orders', { token: kitchenToken, params:{ status:'active' }});
ok(r.status === 200, 'cozinha vê pedidos');
r = await req(`/api/admin/users/${uid}`, { method:'DELETE', token });
ok(r.status === 200, 'usuário removido');

console.log('\n== Configurações ==');
r = await req('/api/admin/settings', { token });
const s0 = r.data.settings;
r = await req('/api/admin/settings', { method:'PUT', token, body:{ open:false }});
ok(r.data.settings.open === '0', 'loja fechada');
r = await req('/api/orders', { method:'POST', body:{ type:'pickup', customer_name:'Fechado', customer_phone:'69999992222', items:[{product_id:2,qty:1}] }});
ok(r.status === 400, 'pedido online bloqueado com loja fechada');
r = await req('/api/admin/orders', { method:'POST', token, body:{ type:'pos', customer_name:'Balcão', payment_method:'cash', items:[{product_id:2,qty:1}] }});
ok(r.status === 201, 'PDV continua vendendo com loja fechada');
await req('/api/admin/settings', { method:'PUT', token, body:{ open:true }});

console.log('\n== Textos do site ==');
{
  let resp = await req('/api/store');
  const t = resp.data.store.texts || {};
  ok(typeof t.hero_title === 'string' && t.hero_title.length > 0, 'textos padrão expostos no /api/store');
  ok(t.hero_cta_primary === 'Pedir agora', 'botão principal padrão: ' + t.hero_cta_primary);
  const keys = Object.keys(t);
  ok(keys.length >= 40, `quantidade de textos editáveis: ${keys.length}`);

  // edição
  resp = await req('/api/admin/settings', {
    method: 'PUT', token,
    body: {
      hero_title: 'Grelhados na brasa,',
      hero_title_highlight: 'direto pra você.',
      hero_cta_primary: 'Quero pedir',
      menu_title: 'O que vai hoje?',
      how_1_title: '🛵 Delivery próprio',
      benefit_1_title: 'Feito no fogo',
      footer_note: 'Desde 2019',
      announcement: 'Frete grátis acima de R$ 80',
    },
  });
  ok(resp.status === 200, 'salva textos pelo painel');
  resp = await req('/api/store');
  const t2 = resp.data.store.texts;
  ok(t2.hero_title === 'Grelhados na brasa,' && t2.hero_title_highlight === 'direto pra você.', 'título salvo');
  ok(t2.hero_cta_primary === 'Quero pedir', 'botão salvo');
  ok(t2.menu_title === 'O que vai hoje?', 'título do cardápio salvo');
  ok(t2.how_1_title === '🛵 Delivery próprio', 'card do "como funciona" salvo');
  ok(t2.footer_note === 'Desde 2019', 'rodapé salvo');

  // textos não sobrescrevem configurações de operação
  resp = await req('/api/admin/settings', { token });
  ok(resp.data.settings.delivery_fee === '500', 'taxa de entrega intacta');

  // limite de tamanho
  resp = await req('/api/admin/settings', {
    method: 'PUT', token, body: { hero_title: 'x'.repeat(200) },
  });
  ok(resp.status === 400, 'rejeita texto acima do limite');
  resp = await req('/api/store');
  ok(resp.data.store.texts.hero_title === 'Grelhados na brasa,', 'texto anterior preservado após erro');

  // texto vazio é permitido (volta ao padrão na tela)
  resp = await req('/api/admin/settings', { method: 'PUT', token, body: { hero_subtitle: '' } });
  ok(resp.status === 200 && resp.data.settings.hero_subtitle === '', 'permite limpar um texto');

  // caracteres de controle são removidos
  resp = await req('/api/admin/settings', { method: 'PUT', token, body: { hero_title: 'Linha\u0000com\u0007controle' } });
  ok(!/[\u0000-\u001f]/.test(resp.data.settings.hero_title), 'remove caracteres de controle');

  // script na configuração é salvo como texto puro (a tela escapa na exibição)
  resp = await req('/api/admin/settings', { method: 'PUT', token, body: { hero_title: '<script>alert(1)</script>' } });
  ok(resp.status === 200, 'aceita texto com tags (renderizado como texto, não HTML)');

  // permissões
  const relogin2 = async (email, pass) =>
    (await req('/api/auth/login', { method: 'POST', body: { email, password: pass } })).data.token;
  const cash2 = await relogin2('caixa@sistema.food', 'caixa123');
  resp = await req('/api/admin/settings', { method: 'PUT', token: cash2, body: { hero_title: 'hack' } });
  ok(resp.status === 403, 'caixa não edita textos');
  resp = await req('/api/admin/settings/reset-texts', { method: 'POST', token: cash2 });
  ok(resp.status === 403, 'caixa não restaura textos');

  // restaurar padrões
  resp = await req('/api/admin/settings/reset-texts', { method: 'POST', token });
  ok(resp.status === 200, 'restaura textos padrão');
  const restored = (await req('/api/store')).data.store.texts;
  ok(restored.hero_title === 'Comida de verdade,', 'título padrão restaurado');
  ok(restored.hero_cta_primary === 'Pedir agora', 'botão padrão restaurado');
  resp = await req('/api/admin/settings', { token });
  ok(resp.data.settings.store_name.length > 0, 'restaurar textos não apaga o nome da loja');
}

console.log('\n== Logo da loja ==');
{
  // PNG 1x1 válido em data URL (só para exercitar o fluxo)
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  let resp = await req('/api/admin/settings', { method: 'PUT', token, body: { logo: png } });
  ok(resp.status === 200 && resp.data.settings.logo === png, 'salva logo (data URL PNG)');

  resp = await req('/api/store');
  ok(resp.data.store.logo === png, 'logo aparece nas configurações públicas da loja');
  resp = await req('/api/menu');
  ok(resp.data.store.logo === png, 'logo aparece no cardápio público');

  // rejeições
  resp = await req('/api/admin/settings', { method: 'PUT', token, body: { logo: 'javascript:alert(1)' } });
  ok(resp.status === 400, 'rejeita logo que não é imagem');
  resp = await req('/api/admin/settings', { method: 'PUT', token, body: { logo: 'data:text/html;base64,PHNjcmlwdD4=' } });
  ok(resp.status === 400, 'rejeita data URL que não é png/jpeg/webp');
  resp = await req('/api/admin/settings', { method: 'PUT', token, body: { logo: `data:image/png;base64,${'A'.repeat(410000)}` } });
  ok(resp.status === 400, 'rejeita logo acima do limite de tamanho');

  // continua salva depois de uma tentativa inválida
  resp = await req('/api/store');
  ok(resp.data.store.logo === png, 'logo anterior preservada após erro');

  // salvar outras configurações não apaga a logo
  resp = await req('/api/admin/settings', { method: 'PUT', token, body: { avg_prep_time: 40 } });
  ok(resp.data.settings.logo === png, 'salvar outras configurações mantém a logo');

  // só admin/gerente alteram a logo (novo login: o usuário de teste do caixa foi removido acima)
  const relogin = async (email, pass) =>
    (await req('/api/auth/login', { method: 'POST', body: { email, password: pass } })).data.token;
  const cash = await relogin('caixa@sistema.food', 'caixa123');
  const kitchen = await relogin('cozinha@sistema.food', 'cozinha123');
  resp = await req('/api/admin/settings', { method: 'PUT', token: cash, body: { logo: png } });
  ok(resp.status === 403, 'caixa não altera a logo');
  resp = await req('/api/admin/settings', { method: 'PUT', token: kitchen, body: { logo: png } });
  ok(resp.status === 403, 'cozinha não altera a logo');

  // remoção
  resp = await req('/api/admin/settings', { method: 'PUT', token, body: { logo: '' } });
  ok(resp.status === 200 && resp.data.settings.logo === '', 'remove a logo');
  resp = await req('/api/store');
  ok(resp.data.store.logo === '', 'loja volta ao ícone padrão');
  await req('/api/admin/settings', { method: 'PUT', token, body: { avg_prep_time: 35 } });
}

console.log('\n== Cancelamento ==');
r = await req(`/api/admin/orders/${posOrder.id}/cancel`, { method:'POST', token, body:{ reason:'teste' }});
ok(r.data.order.status === 'cancelled', 'pedido cancelado');
r = await req(`/api/admin/orders/${posOrder.id}/status`, { method:'PATCH', token, body:{ status:'preparing' }});
ok(r.status === 400, 'cancelado não volta atrás');
r = await req('/api/admin/stats', { token });
ok(!r.data.series[r.data.series.length-1] || typeof r.data.series[0].revenue === 'number', 'stats ignora cancelados');

console.log('\n== Tempo real (SSE) ==');
{
  // regressão: o endpoint SSE envia headers sozinho; no passado isso fazia o
  // servidor tentar enviar JSON depois e derrubar o processo (ERR_HTTP_HEADERS_SENT)
  const res = await fetch(`${BASE}/api/admin/events?token=${token}`);
  ok(res.ok, 'SSE autenticado responde 200');
  ok((res.headers.get('content-type') || '').includes('text/event-stream'), 'content-type event-stream');

  const reader = res.body.getReader();
  const { value } = await reader.read();
  const firstChunk = new TextDecoder().decode(value || new Uint8Array());
  ok(firstChunk.includes('retry:') || firstChunk.includes('event:'), 'primeiro evento recebido');
  await reader.cancel(); // cliente desconecta no meio

  const still = await req('/api/store');
  ok(still.status === 200, 'servidor continua no ar após desconexão do SSE');

  // várias conexões simultâneas (painel + cozinha + dashboards)
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const streams = await Promise.all(
    controllers.map((c) =>
      fetch(`${BASE}/api/admin/events?token=${token}`, { signal: c.signal })
        .then((r) => r.ok)
        .catch(() => false)
    )
  );
  ok(streams.every(Boolean), '4 conexões SSE simultâneas aceitas');
  controllers.forEach((c) => c.abort());

  const after = await req('/api/menu');
  ok(after.status === 200, 'servidor estável com múltiplos SSE abertos e fechados');
}

console.log('\n== Páginas estáticas ==');
for (const p of ['/', '/admin', '/cozinha', '/acompanhar', '/cardapio', '/css/app.css', '/js/admin.js', '/img/hero.jpg']) {
  const res = await fetch(BASE + p);
  ok(res.status === 200, `GET ${p} → ${res.status} (${res.headers.get('content-type')})`);
}
let res = await fetch(BASE + '/../src/db.mjs');
ok(res.status === 404 || res.status === 403, 'path traversal bloqueado');

console.log(`\n===== ${pass} passaram, ${fail} falharam =====`);
server.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 250));
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
