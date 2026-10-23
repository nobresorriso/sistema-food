// src/server.mjs — servidor HTTP + arquivos estáticos (sem dependências)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';
import { HttpError } from './util.mjs';
import { DB_FILE } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const PAGES = {
  '/': 'index.html',
  '/cardapio': 'index.html',
  '/admin': 'admin.html',
  '/painel': 'admin.html',
  '/cozinha': 'cozinha.html',
  '/acompanhar': 'acompanhar.html',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let file = PAGES[pathname];
  if (!file) {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const target = path.resolve(PUBLIC, rel);
    if (!target.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    file = target;
  } else {
    file = path.join(PUBLIC, file);
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        `<!doctype html><meta charset="utf-8"><title>404</title>
         <body style="font-family:system-ui;background:#12100e;color:#f5efe6;display:grid;place-items:center;height:100vh;margin:0">
         <div style="text-align:center"><h1 style="font-size:64px;margin:0">404</h1>
         <p>Página não encontrada.</p><a href="/" style="color:#ff7a3d">Voltar ao cardápio</a></div>`
      );
    }
    const ext = path.extname(file).toLowerCase();
    const isAsset = ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.ico', '.woff2'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // código sempre fresco durante os testes; imagens podem ficar em cache
      'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'URL inválida.' });
  }

  res.setHeader('Referrer-Policy', 'same-origin');

  if (url.pathname.startsWith('/api/')) {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        });
        return res.end();
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      const out = await handleApi(req, res, url);
      if (!res.writableEnded && out) sendJson(res, out.status, out.body);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[erro]', err);
      if (!res.writableEnded) {
        sendJson(res, status, { error: err.message || 'Erro interno do servidor.' });
      }
    }
    if (url.pathname !== '/api/admin/events') {
      console.log(`${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Método não permitido');
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  console.log('  🍔  SISTEMA FOOD  ·  100% grátis, sem dependências');
  console.log(`${line}`);
  console.log(`  Cardápio online :  http://localhost:${PORT}/`);
  console.log(`  Painel da loja  :  http://localhost:${PORT}/admin`);
  console.log(`  Tela da cozinha :  http://localhost:${PORT}/cozinha`);
  console.log(`${line}`);
  console.log('  Acesso do painel: admin@sistema.food / admin123');
  console.log('                   caixa@sistema.food / caixa123');
  console.log(`  Banco de dados  :  ${path.relative(ROOT, DB_FILE)}`);
  console.log(`${line}\n`);
});

process.on('SIGINT', () => {
  console.log('\nEncerrando...');
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[!] A porta ${PORT} já está em uso. Rode com outra porta: PORT=3001 npm start\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
