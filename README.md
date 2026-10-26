# 🍔 Sistema Food

Sistema completo de pedidos para restaurantes, lanchonetes, pizzarias e food trucks —
com **vendas online** (cardápio + delivery) e **vendas no local** (balcão, mesa e retirada).

**Custo zero de verdade:** sem mensalidade, sem gateway obrigatório, sem banco de dados na nuvem.
Roda com Node.js puro e o SQLite que já vem embutido nele — **zero dependências** (`package.json` não tem nenhum pacote).

---

## 🚀 Como rodar (2 minutos)

```bash
# precisa do Node.js 22.5 ou superior: https://nodejs.org
npm start
```

Na primeira execução o banco é criado e o cardápio de exemplo é carregado automaticamente.

| Onde | Endereço | Para quê |
|---|---|---|
| 🍽️ Cardápio online | http://localhost:3000 | Cliente escolhe e faz o pedido |
| 📊 Painel da loja | http://localhost:3000/admin | Pedidos, PDV, cardápio, relatórios |
| 👨‍🍳 Tela da cozinha | http://localhost:3000/cozinha | Produção em tempo real (KDS) |
| 🛵 Meu pedido | http://localhost:3000/acompanhar | Cliente acompanha o status |

### Contas de demonstração

| Perfil | E-mail | Senha | Acesso |
|---|---|---|---|
| Administrador | `admin@sistema.food` | `admin123` | Tudo |
| Caixa | `caixa@sistema.food` | `caixa123` | Pedidos, PDV, mesas |
| Cozinha | `cozinha@sistema.food` | `cozinha123` | Tela de produção |

> ⚠️ **Troque essas senhas** antes de colocar no ar (Painel → Equipe).

### Atalhos úteis

```bash
npm run dev     # reinicia sozinho quando você edita o código
npm run demo    # cria pedidos de exemplo para ver os relatórios com dados
npm run reset   # apaga tudo e recomeça do zero
npm test        # 70 testes automáticos da API (roda em banco isolado)
```

Para usar outra porta: `PORT=8080 npm start`.

---

## ✨ O que o sistema faz

### Identidade da marca
- Upload da **logo** direto nas configurações (PNG, JPG ou WEBP)
- A imagem é redimensionada no navegador antes de salvar — não pesa no banco
- Aparece no cardápio, no rodapé, no painel, na tela da cozinha e no favicon da aba
- Um clique para remover e voltar ao ícone padrão

### Para o cliente (online)
- Cardápio com categorias, busca, preço promocional e tempo de preparo
- Carrinho que **não perde os itens** se a página for recarregada
- Três formas de receber: **entrega**, **retirada no balcão** e **consumo na mesa**
- Cupom de desconto validado no servidor (não dá para burlar pelo navegador)
- Taxa de entrega e frete grátis automáticos por valor do pedido
- Pagamento em **PIX** (gera o copia-e-cola com valor exato), cartão ou dinheiro com troco
- Página de acompanhamento com linha do tempo e atualização automática
- Link de pedido na mesa via QR code: `sualoja.com/?mesa=3`

### Para a loja (painel)
- **Visão geral**: faturamento do dia, ticket médio, pedidos em andamento, gráfico de 7 dias, mais vendidos
- **Pedidos**: filtros, busca, detalhes, impressão de cupom, avanço de status e cancelamento
- **PDV / balcão**: toque nos produtos, escolha o tipo de venda e finalize em segundos
- **Mesas**: mapa de ocupação, comanda por mesa, liberação automática ao concluir
- **Cardápio**: cadastro de produtos, preços, promoções, pausar item, categorias
- **Cupons**: percentual ou valor fixo, mínimo de pedido, limite de usos e validade
- **Relatórios**: faturamento por dia, por tipo de venda, por forma de pagamento e ranking de produtos
- **Equipe**: quatro níveis de permissão (admin, gerente, caixa, cozinha)
- **Configurações**: nome, **logo da loja**, endereço, WhatsApp, taxas, horário, chave PIX e abrir/fechar a loja

### Para a cozinha
- Tela própria (KDS) com três colunas: **Novos → Em preparo → Prontos**
- Pedidos aparecem em tempo real (SSE), com alerta sonoro
- Tempo decorrido por pedido, destaque em amarelo (15 min) e vermelho (25 min)
- Funciona em tablet ou TV na parede, em tela cheia

---

## 🧱 Como foi feito (e por que é grátis)

```
src/
  server.mjs   servidor HTTP + arquivos estáticos (Node puro)
  api.mjs      rotas da API, regras de negócio e permissões
  db.mjs       banco SQLite nativo, esquema e cardápio inicial
  pix.mjs      gerador do payload PIX (padrão EMV do Banco Central)
  util.mjs     utilidades, status e validações
  seed.mjs     reset / dados de demonstração
public/
  index.html   cardápio online
  admin.html   painel da loja
  cozinha.html tela da cozinha
  acompanhar.html  rastreio do pedido
  js/ css/     front-end em JS puro (sem build, sem framework)
data/food.db   banco de dados local (criado sozinho, ignorado pelo Git)
```

- **Banco:** `node:sqlite` (embutido no Node 22+) — zero instalação.
- **Servidor:** `node:http` — zero Express.
- **Front-end:** ES Modules nativos — zero React/Webpack/Vite.
- **Tempo real:** Server-Sent Events — zero serviço de mensageria.
- **Autenticação:** sessões com token + senha em `scrypt` — zero serviço de login.

Nada disso tem custo mensal. O único custo possível é onde você hospeda.

---

## 💳 Sobre o PIX

O sistema gera o **PIX copia e cola** no padrão oficial (BR Code), com valor, nome do recebedor
e identificador do pedido. O cliente paga no app do banco e o atendente confirma o recebimento
no painel com um clique.

Isso é **proposital**: conciliação automática exige um gateway/PSP com credenciais e taxas.
Quando quiser automatizar, é só plugar um provedor (Mercado Pago, Asaas, PagSeguro…) em
`src/api.mjs` e usar um webhook para marcar `payment_status = 'paid'`. A estrutura já está pronta para isso.

> 🔒 Para receber de verdade, troque a chave PIX de exemplo em **Painel → Configurações** por uma
> chave real do seu banco (CNPJ, telefone, e-mail ou chave aleatória).

---

## 🌐 Colocando no ar de graça

1. **Melhor opção para testar:** rodar no seu computador e abrir o cardápio pelo celular
   usando o IP da máquina na mesma rede Wi-Fi (`http://192.168.x.x:3000`).
2. **Hospedagem gratuita:** Render, Railway, Fly.io ou Koyeb aceitam Node 22.
   Atenção: os planos gratuitos costumam ter disco temporário — o arquivo `data/food.db`
   pode ser apagado em um redeploy. Para uso real, use um plano com disco persistente
   ou faça backup do arquivo.
3. **Domínio próprio** é opcional e custa só o domínio (~R$ 40/ano). O sistema funciona
   igual em `http://localhost:3000`.

Backup do sistema inteiro = copiar a pasta `data/`. Simples assim.

---

## 🔐 Segurança já incluída

- Senhas com hash `scrypt` + salt (nunca em texto puro)
- Sessões com token aleatório de 256 bits, expirando em 30 dias
- Permissões checadas no servidor em **todas** as rotas (não confia no front)
- Preços, descontos, frete e totais recalculados no servidor — o navegador não decide valor
- Consulta de pedido exige código **+ telefone**
- Rate limit no login (8 tentativas por e-mail/IP a cada 10 minutos)
- Proteção contra path traversal nos arquivos estáticos

---

## 🗺️ Ideias para a próxima fase

- [ ] QR code PIX desenhado na tela (hoje só o copia-e-cola)
- [ ] Impressão automática na cozinha (ESC/POS em impressora térmica)
- [ ] Integração com WhatsApp Cloud API para avisos de status
- [ ] App PWA instalável com notificações
- [ ] Fichas técnicas e controle de estoque
- [ ] Múltiplas lojas / franquias

Nada disso é necessário para começar a vender — o sistema já cobre o ciclo completo:
**cliente pede → cozinha produz → caixa recebe → relatório mostra o resultado.**

---

Feito com Node.js puro, SQLite e muita fome. 🍔
