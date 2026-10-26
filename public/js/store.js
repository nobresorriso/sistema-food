// public/js/store.js — cardápio online, carrinho e checkout
import {
  $, $$, api, auth, money, esc, toast, openModal, closeModal, maskPhone,
  whatsappLink, onlyDigits, applyLogo, TYPE_LABEL,
} from './api.js';

const state = {
  store: null,
  categories: [],
  tables: [],
  products: new Map(),
  activeCat: 'all',
  search: '',
  cart: [],
  type: 'delivery',
  tableId: null,
  coupon: { code: '', discount: 0 },
  sending: false,
};

const CART_KEY = 'sf_cart_v1';

// ---------------------------------------------------------------- init
init();

async function init() {
  loadCartFromStorage();
  bindStaticEvents();
  document.getElementById('year').textContent = new Date().getFullYear();
  try {
    const data = await api('/api/menu');
    state.store = data.store;
    state.categories = data.categories;
    state.tables = data.tables;
    for (const cat of data.categories) for (const p of cat.products) state.products.set(p.id, { ...p, category: cat.name });
    applyStoreInfo();
    renderTabs();
    renderMenu();
    validateCart();
    renderCart();
    handleDeepLink();
  } catch (err) {
    $('#menuBody').innerHTML = `<div class="empty"><div class="emoji">😕</div>
      <p>Não foi possível carregar o cardápio.</p>
      <button class="btn btn-soft" onclick="location.reload()">Tentar de novo</button></div>`;
    console.error(err);
  }
}

function applyStoreInfo() {
  const s = state.store;
  const setText = (id, value) => { const el = document.getElementById(id); if (el && value) el.textContent = value; };

  document.title = `${s.store_name} · Peça online`;
  setText('brandName', s.store_name);
  setText('brandTag', s.store_tagline);
  setText('metaTime', `${s.avg_prep_time} min`);
  setText('metaFee', s.delivery_fee ? money(s.delivery_fee) : 'Grátis');
  setText('metaFree', s.free_delivery_above ? `Acima de ${money(s.free_delivery_above)}` : 'Sempre grátis');
  setText('visitName', s.store_name);
  setText('visitAddress', s.address);
  setText('visitHours', s.open_hours);
  setText('visitPhone', s.store_phone);
  setText('visitPix', s.pix_key);
  setText('footerName', s.store_name);
  setText('footerStore', s.store_name);

  if (s.announcement) {
    const a = document.getElementById('announce');
    a.textContent = s.announcement;
    a.hidden = false;
  }

  applyLogo(s.logo);

  const open = s.open;
  $('#openDot').classList.toggle('closed', !open);

  applyTexts(s);

  const whats = document.getElementById('whatsBtn');
  if (whats && s.whatsapp) {
    whats.href = whatsappLink(s.whatsapp, `Olá! Vim pelo cardápio online do ${s.store_name}.`);
  }

  document.querySelectorAll('[data-store-name]').forEach((el) => (el.textContent = s.store_name));
}

/**
 * Aplica os textos editáveis do painel em todo o cardápio.
 * Campos vazios usam o padrão, para a loja nunca ficar com espaço em branco.
 */
function applyTexts(s) {
  const t = s.texts || {};
  const set = (id, value, fallback = '') => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || fallback;
  };
  const setPlaceholder = (id, value, fallback) => {
    const el = document.getElementById(id);
    if (el) el.placeholder = value || fallback;
  };

  // destaque
  set('heroTitle', t.hero_title, 'Comida de verdade,');
  set('heroTitleHighlight', t.hero_title_highlight, 'feita na brasa.');
  set('heroSub', t.hero_subtitle, s.store_tagline);
  set('heroCtaPrimary', t.hero_cta_primary, 'Pedir agora');
  set('heroCtaSecondary', t.hero_cta_secondary, 'Pedir na mesa');
  set('metaLabel1', t.hero_meta_1, 'Tempo médio');
  set('metaLabel2', t.hero_meta_2, 'Entrega');
  set('metaLabel3', t.hero_meta_3, 'Frete grátis');
  set('metaLabel4', t.hero_meta_4, 'Pagamento');

  // vantagens
  for (let i = 1; i <= 4; i++) {
    set(`benefit${i}Icon`, t[`benefit_${i}_icon`]);
    set(`benefit${i}Title`, t[`benefit_${i}_title`]);
    set(`benefit${i}Text`, t[`benefit_${i}_text`]);
  }
  // valores dinâmicos quando o texto está vazio
  if (!t.benefit_2_text) {
    set('benefit2Text', s.free_delivery_above ? `Grátis acima de ${money(s.free_delivery_above)}` : 'Entrega grátis');
  }
  if (!t.benefit_4_title) set('benefit4Title', s.open_hours);

  // cardápio
  set('menuEyebrow', t.menu_eyebrow, 'Cardápio');
  set('menuTitle', t.menu_title, 'Escolha o que vai hoje');
  setPlaceholder('searchInput', t.menu_search, 'Buscar no cardápio...');

  // como funciona
  set('howEyebrow', t.how_eyebrow, 'Simples assim');
  set('howTitle', t.how_title, 'Três jeitos de pedir');
  for (let i = 1; i <= 3; i++) {
    set(`how${i}Title`, t[`how_${i}_title`]);
    set(`how${i}Text`, t[`how_${i}_text`]);
    set(`how${i}Link`, t[`how_${i}_link`]);
  }

  // visita / contato
  set('visitEyebrow', t.visit_eyebrow, 'Venha nos visitar');
  set('visitCardTitle', t.visit_card_title, 'Prefere falar com a gente?');
  set('visitCardText', t.visit_card_text);
  set('visitWhatsBtn', t.visit_whats_btn, 'Falar no WhatsApp');
  set('visitTrackBtn', t.visit_track_btn, 'Acompanhar meu pedido');
  set('visitHoursLabel', t.visit_hours_label, 'Funcionamento');
  set('visitPhoneLabel', t.visit_phone_label, 'Telefone / WhatsApp');
  set('visitPixLabel', t.visit_pix_label, 'Chave PIX');

  // rodapé
  set('footerNote', t.footer_note, 'Sabor de verdade');

  // rótulo de aberto/fechado
  const openLabel = document.getElementById('openLabel');
  if (openLabel) {
    openLabel.textContent = s.open
      ? t.hero_badge_open || 'Aberto agora'
      : t.hero_badge_closed || 'Fechado no momento';
  }
}

function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  const mesa = params.get('mesa') || params.get('table');
  if (mesa) {
    const table = state.tables.find((t) => String(t.id) === String(mesa) || t.name.toLowerCase() === `mesa ${mesa}`.toLowerCase());
    if (table) {
      state.type = 'dinein';
      state.tableId = table.id;
      updateTypeTabs();
      renderCart();
      setTimeout(() => toast(`Você está pedindo na ${table.name}.`, 'info'), 400);
    }
  }
}

// ---------------------------------------------------------------- menu
function renderTabs() {
  const host = $('#categoryTabs');
  const total = state.categories.reduce((a, c) => a + c.products.length, 0);
  host.innerHTML =
    `<button class="tab active" data-cat="all">🍽️ Tudo <span class="tiny">(${total})</span></button>` +
    state.categories
      .map(
        (c) =>
          `<button class="tab" data-cat="${c.id}">${esc(c.emoji)} ${esc(c.name)} <span class="tiny">(${c.products.length})</span></button>`
      )
      .join('');
  host.querySelectorAll('.tab').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.activeCat = btn.dataset.cat === 'all' ? 'all' : Number(btn.dataset.cat);
      host.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      renderMenu();
    })
  );
}

function productCard(p) {
  const qty = state.cart.filter((i) => i.productId === p.id).reduce((a, i) => a + i.qty, 0);
  const price = p.promo_price ?? p.price;
  return `
    <article class="product-card" data-id="${p.id}">
      ${p.promo_price ? '<span class="promo-tag">PROMO</span>' : ''}
      <div class="product-top">
        <div class="product-thumb">${esc(p.emoji || '🍽️')}</div>
        <div class="product-body">
          <h3 class="product-name">${esc(p.name)}</h3>
          <p class="product-desc">${esc(p.description)}</p>
        </div>
      </div>
      <div class="product-foot">
        <div>
          <div class="price">
            <strong>${money(price)}</strong>
            ${p.promo_price ? `<s>${money(p.price)}</s>` : ''}
          </div>
          <div class="product-meta"><span>⏱ ${p.prep_time || 20} min</span><span>${esc(p.category)}</span></div>
        </div>
        ${
          qty > 0
            ? `<div class="qty-ctl" data-id="${p.id}">
                 <button data-act="dec" aria-label="Remover um">−</button>
                 <span>${qty}</span>
                 <button data-act="inc" aria-label="Adicionar um">+</button>
               </div>`
            : `<button class="add-btn" data-act="add" data-id="${p.id}" aria-label="Adicionar ${esc(p.name)}">+</button>`
        }
      </div>
    </article>`;
}

function renderMenu() {
  const host = $('#menuBody');
  const search = state.search.trim().toLowerCase();
  let cats = state.categories;
  if (state.activeCat !== 'all') cats = cats.filter((c) => c.id === state.activeCat);

  if (search) {
    const items = cats
      .flatMap((c) => c.products)
      .filter((p) => (p.name + ' ' + p.description).toLowerCase().includes(search));
    $('#resultCount').textContent = `${items.length} resultado${items.length === 1 ? '' : 's'}`;
    host.innerHTML = items.length
      ? `<div class="menu-grid">${items.map(productCard).join('')}</div>`
      : `<div class="empty"><div class="emoji">🔍</div><p>Nada encontrado para “${esc(state.search)}”.</p></div>`;
    bindProductEvents(host);
    return;
  }

  $('#resultCount').textContent = '';
  const blocks = cats.filter((c) => c.products.length);
  host.innerHTML = blocks.length
    ? blocks
        .map(
          (c) => `
        <div class="cat-block" id="cat-${c.id}">
          <h3 class="cat-title"><span class="emoji">${esc(c.emoji)}</span> ${esc(c.name)}
            <span class="count">${c.products.length} itens</span></h3>
          <div class="menu-grid">${c.products.map(productCard).join('')}</div>
        </div>`
        )
        .join('')
    : `<div class="empty"><div class="emoji">🍽️</div><p>Cardápio em atualização.</p></div>`;
  bindProductEvents(host);
}

function bindProductEvents(host) {
  host.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      if (btn.dataset.act === 'add') {
        addToCart(id, 1);
      } else if (btn.dataset.act === 'inc') {
        addToCart(id, 1);
      } else if (btn.dataset.act === 'dec') {
        addToCart(id, -1);
      }
    });
  });
  host.querySelectorAll('.product-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      addToCart(Number(card.dataset.id), 1);
    });
  });
}

// ---------------------------------------------------------------- carrinho
function loadCartFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || 'null');
    if (saved) {
      state.cart = Array.isArray(saved.cart) ? saved.cart : [];
      state.type = saved.type || 'delivery';
      state.tableId = saved.tableId || null;
      state.coupon = saved.coupon || { code: '', discount: 0 };
    }
  } catch { /* ignore */ }
}

function saveCart() {
  localStorage.setItem(
    CART_KEY,
    JSON.stringify({ cart: state.cart, type: state.type, tableId: state.tableId, coupon: state.coupon })
  );
}

/** Remove itens cujo produto saiu do cardápio */
function validateCart() {
  const before = state.cart.length;
  state.cart = state.cart.filter((i) => state.products.has(i.productId));
  if (state.cart.length !== before) {
    saveCart();
    toast('Alguns itens saíram do cardápio e foram removidos.', 'info');
  }
  for (const item of state.cart) {
    const p = state.products.get(item.productId);
    const price = p.promo_price ?? p.price;
    if (item.price !== price || item.name !== p.name || item.emoji !== p.emoji) {
      item.price = price;
      item.name = p.name;
      item.emoji = p.emoji;
    }
  }
}

function addToCart(productId, delta, notes = '') {
  const product = state.products.get(productId);
  if (!product) return;
  const existing = state.cart.find((i) => i.productId === productId && i.notes === notes);
  if (existing) {
    existing.qty += delta;
    if (existing.qty <= 0) state.cart = state.cart.filter((i) => i !== existing);
  } else if (delta > 0) {
    state.cart.push({
      productId,
      name: product.name,
      emoji: product.emoji,
      price: product.promo_price ?? product.price,
      qty: delta,
      notes,
    });
  }
  state.coupon = { code: '', discount: 0 };
  saveCart();
  renderMenu();
  renderCart();
  bumpCart();
}

function cartCount() {
  return state.cart.reduce((a, i) => a + i.qty, 0);
}
function cartSubtotal() {
  return state.cart.reduce((a, i) => a + i.price * i.qty, 0);
}

function deliveryFee() {
  if (state.type !== 'delivery' || !state.cart.length) return 0;
  const s = state.store;
  if (s.free_delivery_above > 0 && cartSubtotal() >= s.free_delivery_above) return 0;
  return s.delivery_fee || 0;
}

function cartTotal() {
  return Math.max(0, cartSubtotal() + deliveryFee() - state.coupon.discount);
}

function bumpCart() {
  const el = $('#cartCount');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function renderCart() {
  const count = cartCount();
  $('#cartCount').textContent = count;
  $('#mobileCount').textContent = count;
  $('#mobileTotal').textContent = money(cartTotal());
  document.body.classList.toggle('cart-has-items', count > 0);
  const mobileBar = document.getElementById('mobileCart');
  if (mobileBar) mobileBar.hidden = false;

  $('#cartSubtitle').textContent =
    count === 0 ? 'Nenhum item ainda' : `${count} item${count > 1 ? 's' : ''} · ${money(cartSubtotal())}`;

  const body = $('#cartBody');

  const tablePicker =
    state.type === 'dinein'
      ? `<div class="card" style="padding:14px;margin-bottom:14px">
           <label class="label" style="display:block;margin-bottom:7px">Em qual mesa você está?</label>
           <select class="select" id="tableSelect">
             <option value="">Selecione a mesa...</option>
             ${state.tables
               .map(
                 (t) =>
                   `<option value="${t.id}" ${String(state.tableId) === String(t.id) ? 'selected' : ''}>${esc(t.name)} · ${t.seats} lugares</option>`
               )
               .join('')}
           </select>
         </div>`
      : '';

  if (!state.cart.length) {
    body.innerHTML = `${tablePicker}
      <div class="empty-cart">
        <div class="big">🛒</div>
        <strong>Seu carrinho está vazio</strong>
        <p class="small">Toque em um item do cardápio para começar.</p>
        <button class="btn btn-soft mt-2" id="goMenu">Ver cardápio</button>
      </div>`;
    bindCartEvents();
    $('#cartFoot').hidden = true;
    return;
  }

  body.innerHTML = `
    ${tablePicker}
    <div class="cart-items">
      ${state.cart
        .map(
          (item, index) => `
        <div class="cart-item">
          <div class="cart-emoji">${esc(item.emoji || '🍽️')}</div>
          <div class="grow">
            <div class="cart-item-name">${esc(item.name)}</div>
            ${item.notes ? `<div class="cart-item-note">📝 ${esc(item.notes)}</div>` : ''}
            <div class="cart-item-price">${money(item.price * item.qty)}</div>
          </div>
          <div class="stack" style="align-items:flex-end;gap:6px">
            <div class="qty-ctl">
              <button data-cart="dec" data-index="${index}">−</button>
              <span>${item.qty}</span>
              <button data-cart="inc" data-index="${index}">+</button>
            </div>
            <button class="cart-remove" data-cart="note" data-index="${index}">✎ observação</button>
          </div>
        </div>`
        )
        .join('')}
    </div>`;

  $('#cartFoot').hidden = false;
  $('#couponInput').value = state.coupon.code || '';
  const fee = deliveryFee();
  const subtotal = cartSubtotal();
  const freeGap = state.store.free_delivery_above - subtotal;

  $('#totals').innerHTML = `
    <div class="line"><span>Subtotal</span><span>${money(subtotal)}</span></div>
    ${
      state.type === 'delivery'
        ? `<div class="line"><span>Entrega</span><span>${fee ? money(fee) : 'Grátis'}</span></div>`
        : `<div class="line"><span>${state.type === 'dinein' ? 'Consumo na mesa' : 'Retirada no balcão'}</span><span>Sem taxa</span></div>`
    }
    ${state.coupon.discount ? `<div class="line discount"><span>Cupom ${esc(state.coupon.code)}</span><span>− ${money(state.coupon.discount)}</span></div>` : ''}
    <div class="line total"><span>Total</span><span>${money(cartTotal())}</span></div>`;

  const min = state.store.min_order || 0;
  const hint = $('#minOrderHint');
  if (state.type === 'delivery' && min && subtotal < min) {
    hint.innerHTML = `<span style="color:var(--yellow)">Faltam ${money(min - subtotal)} para o pedido mínimo.</span>`;
  } else if (state.type === 'delivery' && freeGap > 0 && state.store.free_delivery_above) {
    hint.textContent = `Faltam ${money(freeGap)} para o frete grátis 🛵`;
  } else if (state.type === 'delivery' && freeGap <= 0 && state.store.free_delivery_above) {
    hint.innerHTML = `<span style="color:var(--green)">Você ganhou frete grátis! 🎉</span>`;
  } else {
    hint.textContent = '';
  }

  const btn = $('#checkoutBtn');
  btn.disabled = state.sending || !state.store.open;
  btn.textContent = state.store.open ? 'Finalizar pedido' : 'Loja fechada — pedidos pausados';

  bindCartEvents();
}

function bindCartEvents() {
  const goMenu = document.getElementById('goMenu');
  if (goMenu) {
    goMenu.addEventListener('click', () => {
      closeDrawer();
      document.getElementById('cardapio').scrollIntoView({ behavior: 'smooth' });
    });
  }
  const tableSelect = document.getElementById('tableSelect');
  if (tableSelect) {
    tableSelect.addEventListener('change', () => {
      state.tableId = tableSelect.value ? Number(tableSelect.value) : null;
      saveCart();
    });
  }
  $$('#cartBody [data-cart]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      const item = state.cart[index];
      if (!item) return;
      if (btn.dataset.cart === 'inc') addToCart(item.productId, 1, item.notes);
      else if (btn.dataset.cart === 'dec') addToCart(item.productId, -1, item.notes);
      else if (btn.dataset.cart === 'note') editNote(index);
    });
  });
}

function editNote(index) {
  const item = state.cart[index];
  if (!item) return;
  openModal(
    `<div class="modal-head"><h3>Observação do item</h3><button class="modal-close" data-close>×</button></div>
     <div class="modal-body">
       <p class="muted small">${esc(item.name)} — ex: sem cebola, ponto da carne, sem molho.</p>
       <textarea class="textarea" id="noteText" maxlength="140" placeholder="Ex: sem cebola e sem picles">${esc(item.notes || '')}</textarea>
     </div>
     <div class="modal-foot">
       <button class="btn btn-ghost" data-close>Cancelar</button>
       <button class="btn btn-primary" id="saveNote">Salvar</button>
     </div>`,
    {
      onMount(root) {
        root.querySelector('#saveNote').addEventListener('click', () => {
          const note = root.querySelector('#noteText').value.trim().slice(0, 140);
          const qty = item.qty;
          state.cart = state.cart.filter((_, i) => i !== index);
          const existing = state.cart.find((i) => i.productId === item.productId && i.notes === note);
          if (existing) existing.qty += qty;
          else state.cart.push({ ...item, notes: note });
          saveCart();
          closeModal();
          renderCart();
          renderMenu();
        });
      },
    }
  );
}

function openDrawer() {
  $('#drawerBackdrop').hidden = false;
  $('#cartDrawer').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  $('#cartDrawer').classList.remove('open');
  $('#drawerBackdrop').hidden = true;
  document.body.style.overflow = '';
}

function updateTypeTabs() {
  $$('.drawer-type-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === state.type));
}

// ---------------------------------------------------------------- checkout
function openCheckout() {
  if (!state.cart.length) return toast('Adicione itens ao pedido.', 'error');
  if (!state.store.open) return toast('A loja está fechada agora. Volte mais tarde!', 'error');
  if (state.type === 'dinein' && !state.tableId) return toast('Escolha a mesa para continuar.', 'error');

  const user = auth.user;
  const subtotal = cartSubtotal();
  const fee = deliveryFee();
  const total = cartTotal();
  const change = state.type === 'delivery' ? 'Endereço de entrega' : 'Endereço (opcional)';

  openModal(
    `<div class="modal-head">
       <div><h3>Finalizar pedido</h3><p class="muted small mt-1">${TYPE_LABEL[state.type]} ${state.tableId ? '· ' + esc(state.tables.find((t) => t.id === state.tableId)?.name || '') : ''}</p></div>
       <button class="modal-close" data-close>×</button>
     </div>
     <div class="modal-body">
       <form id="checkoutForm" novalidate>
         <div class="grid-2">
           <div class="field">
             <label for="cName">Seu nome *</label>
             <input class="input" id="cName" name="name" required maxlength="80" value="${esc(user?.name || '')}" placeholder="Como podemos te chamar?" />
           </div>
           <div class="field">
             <label for="cPhone">WhatsApp *</label>
             <input class="input" id="cPhone" name="phone" inputmode="tel" required maxlength="16" value="${esc(user?.phone || '')}" placeholder="(69) 99999-0000" />
           </div>
         </div>

         <div class="field mt-2">
           <label for="cAddress">${change}</label>
           <textarea class="textarea" id="cAddress" name="address" rows="2" maxlength="240"
             placeholder="Rua, número, bairro, complemento e ponto de referência" ${state.type === 'delivery' ? 'required' : ''}></textarea>
         </div>

         <div class="mt-2">
           <span class="label">Forma de pagamento</span>
           <div class="pay-options mt-1" id="payOptions">
             <button type="button" class="pay-option active" data-pay="pix"><span>💠</span>PIX</button>
             <button type="button" class="pay-option" data-pay="card"><span>💳</span>Cartão</button>
             <button type="button" class="pay-option" data-pay="cash"><span>💵</span>Dinheiro</button>
           </div>
           <input type="hidden" id="payMethod" value="pix" />
         </div>

         <div class="field mt-2 hidden" id="changeField">
           <label for="cChange">Troco para quanto?</label>
           <input class="input" id="cChange" inputmode="decimal" placeholder="Ex: 100,00" />
         </div>

         <div class="field mt-2">
           <label for="cNotes">Observações do pedido</label>
           <textarea class="textarea" id="cNotes" rows="2" maxlength="300" placeholder="Ex: entregar na portaria, sem talheres..."></textarea>
         </div>

         <div class="checkout-summary mt-2">
           <div class="line"><span>Subtotal (${cartCount()} itens)</span><span>${money(subtotal)}</span></div>
           ${state.type === 'delivery' ? `<div class="line"><span>Entrega</span><span>${fee ? money(fee) : 'Grátis'}</span></div>` : ''}
           ${state.coupon.discount ? `<div class="line" style="color:var(--green)"><span>Cupom ${esc(state.coupon.code)}</span><span>− ${money(state.coupon.discount)}</span></div>` : ''}
           <div class="line total"><span>Total</span><span>${money(total)}</span></div>
         </div>

         <p class="form-error mt-1" id="checkoutError"></p>
       </form>
     </div>
     <div class="modal-foot">
       <button class="btn btn-ghost" data-close>Voltar</button>
       <button class="btn btn-primary" id="confirmOrder">Confirmar · ${money(total)}</button>
     </div>`,
    {
      className: 'modal-lg',
      onMount(root) {
        const phone = root.querySelector('#cPhone');
        phone.addEventListener('input', () => { phone.value = maskPhone(phone.value); });

        root.querySelectorAll('.pay-option').forEach((btn) => {
          btn.addEventListener('click', () => {
            root.querySelectorAll('.pay-option').forEach((b) => b.classList.toggle('active', b === btn));
            root.querySelector('#payMethod').value = btn.dataset.pay;
            root.querySelector('#changeField').classList.toggle('hidden', btn.dataset.pay !== 'cash');
          });
        });

        root.querySelector('#confirmOrder').addEventListener('click', () => submitOrder(root));
        root.querySelector('#checkoutForm').addEventListener('submit', (e) => {
          e.preventDefault();
          submitOrder(root);
        });
        setTimeout(() => root.querySelector('#cName').focus(), 120);
      },
    }
  );
}

async function submitOrder(root) {
  const errBox = root.querySelector('#checkoutError');
  const name = root.querySelector('#cName').value.trim();
  const phone = onlyDigits(root.querySelector('#cPhone').value);
  const address = root.querySelector('#cAddress').value.trim();
  const notes = root.querySelector('#cNotes').value.trim();
  const payment = root.querySelector('#payMethod').value;
  const changeRaw = root.querySelector('#cChange')?.value || '';

  const fail = (msg) => {
    errBox.textContent = msg;
    errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  if (name.length < 2) return fail('Informe seu nome.');
  if (state.type === 'delivery' && phone.length < 10) return fail('Informe um WhatsApp válido com DDD.');
  if (phone && phone.length < 10) return fail('WhatsApp incompleto. Confira o DDD.');
  if (state.type === 'delivery' && address.length < 8) return fail('Informe o endereço completo para entrega.');
  if (state.type === 'dinein' && !state.tableId) return fail('Escolha a mesa.');
  const min = state.store.min_order || 0;
  if (state.type === 'delivery' && cartSubtotal() < min) {
    return fail(`O pedido mínimo para entrega é ${money(min)}.`);
  }

  let changeFor = null;
  if (payment === 'cash' && changeRaw.trim()) {
    const parsed = Number(changeRaw.replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) changeFor = Math.round(parsed * 100);
  }

  const btn = root.querySelector('#confirmOrder');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Enviando...';
  state.sending = true;

  try {
    const payload = {
      type: state.type,
      customer_name: name,
      customer_phone: phone,
      address: state.type === 'delivery' ? address : address || '',
      table_id: state.type === 'dinein' ? state.tableId : null,
      payment_method: payment,
      change_for: changeFor,
      notes,
      coupon: state.coupon.code || '',
      items: state.cart.map((i) => ({ product_id: i.productId, qty: i.qty, notes: i.notes })),
    };
    const { order } = await api('/api/orders', { method: 'POST', body: payload, auth: true });
    state.cart = [];
    state.coupon = { code: '', discount: 0 };
    state.tableId = null;
    saveCart();
    renderCart();
    renderMenu();
    closeModal();
    closeDrawer();
    showSuccess(order);
  } catch (err) {
    fail(err.message);
    btn.disabled = false;
    btn.textContent = `Confirmar · ${money(cartTotal())}`;
  } finally {
    state.sending = false;
  }
}

function showSuccess(order) {
  const waText =
    `*Novo pedido ${order.code}*\n` +
    `${order.customer_name} · ${TYPE_LABEL[order.type]}\n` +
    order.items.map((i) => `${i.qty}x ${i.name}`).join('\n') +
    `\n\nTotal: ${money(order.total)}`;
  const wa = state.store.whatsapp ? whatsappLink(state.store.whatsapp, waText) : '#';

  openModal(
    `<div class="modal-head"><h3>Pedido confirmado!</h3><button class="modal-close" data-close>×</button></div>
     <div class="modal-body">
       <div class="success-box">
         <div class="success-emoji">🎉</div>
         <p class="muted small">Seu pedido foi enviado para a cozinha.</p>
         <div class="success-code">${esc(order.code)}</div>
         <p class="small">Previsão: <strong>${state.store.avg_prep_time} min</strong> · ${money(order.total)}</p>
       </div>
       ${
         order.pix
           ? `<div class="pix-box">
                <div class="between mb-2">
                  <strong class="small">💠 Pague com PIX</strong>
                  <span class="tiny muted">${esc(order.pix.holder || '')}</span>
                </div>
                <div class="pix-code" id="pixCode">${esc(order.pix.payload)}</div>
                <div class="row mt-2">
                  <button class="btn btn-sm btn-primary grow" id="copyPix">Copiar código PIX</button>
                </div>
                <p class="tiny muted mt-2">Chave: <span class="mono">${esc(order.pix.key)}</span></p>
              </div>`
           : ''
       }
       <div class="alert alert-info small">
         Guarde o código <strong>${esc(order.code)}</strong>. Você pode acompanhar o status em tempo real.
       </div>
       <div class="row wrap">
         <a class="btn btn-primary grow" href="/acompanhar?code=${encodeURIComponent(order.code)}&phone=${encodeURIComponent(order.customer_phone)}">Acompanhar pedido</a>
         <a class="btn btn-ghost" href="${wa}" target="_blank" rel="noopener">${state.store.whatsapp ? 'Avisar no WhatsApp' : ''}</a>
       </div>
     </div>`,
    {
      onMount(root) {
        const copy = root.querySelector('#copyPix');
        if (copy) {
          copy.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(root.querySelector('#pixCode').textContent.trim());
              copy.textContent = '✓ Copiado!';
              toast('Código PIX copiado. Cole no app do seu banco.', 'success');
            } catch {
              const range = document.createRange();
              range.selectNodeContents(root.querySelector('#pixCode'));
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand('copy');
              copy.textContent = '✓ Copiado!';
            }
          });
        }
      },
    }
  );
}

// ---------------------------------------------------------------- eventos
function bindStaticEvents() {
  $('#cartBtn').addEventListener('click', () => { renderCart(); openDrawer(); });
  $('#mobileCartBtn').addEventListener('click', () => { renderCart(); openDrawer(); });
  $('#closeDrawer').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#checkoutBtn').addEventListener('click', openCheckout);
  $('#applyCoupon').addEventListener('click', applyCoupon);
  $('#couponInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCoupon(); });

  const goTable = () => {
    state.type = 'dinein';
    updateTypeTabs();
    renderCart();
    openDrawer();
    setTimeout(() => $('#tableSelect')?.focus(), 350);
  };
  $('#tableCta').addEventListener('click', goTable);
  $('#tableCta2').addEventListener('click', goTable);

  $$('.drawer-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.type = btn.dataset.type;
      if (state.type !== 'dinein') state.tableId = null;
      state.coupon = { code: '', discount: 0 };
      updateTypeTabs();
      saveCart();
      renderCart();
    });
  });

  $('#searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderMenu();
  });

  window.addEventListener('scroll', () => {
    $('#siteHeader').classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

async function applyCoupon() {
  const code = $('#couponInput').value.trim().toUpperCase();
  if (!code) return;
  try {
    const res = await api('/api/coupons/validate', {
      method: 'POST',
      body: { code, subtotal: cartSubtotal() },
    });
    if (!res.valid) return toast('Cupom inválido.', 'error');
    state.coupon = { code: res.code, discount: res.discount };
    saveCart();
    renderCart();
    toast(`Cupom aplicado: − ${money(res.discount)}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}
