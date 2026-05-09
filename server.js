require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

const TINY_CLIENT_ID = process.env.TINY_CLIENT_ID;
const TINY_CLIENT_SECRET = process.env.TINY_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/callback`;

const TINY_API_V3 = "https://erp.tiny.com.br/public-api/v3";
const TINY_AUTH_URL = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect";

const DIAS_ANALISE = 60;
const DIAS_COBERTURA = 40;

// ── Rate limit: espera entre requisições ──────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tinyGetSafe(token, endpoint, params = {}, tentativa = 1) {
  try {
    await sleep(300); // 300ms entre cada requisição = máx ~3 req/s
    const res = await axios.get(`${TINY_API_V3}/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });
    return res.data;
  } catch (e) {
    if (e.response?.status === 429 && tentativa <= 3) {
      console.log(`Rate limit em ${endpoint}, aguardando ${tentativa * 2}s...`);
      await sleep(tentativa * 2000);
      return tinyGetSafe(token, endpoint, params, tentativa + 1);
    }
    throw e;
  }
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "tiny-secret-key-2024",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));

// ── Página inicial ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const autenticado = !!req.session.access_token;
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Sugestão de Compra</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#eff6ff,#f0fdf4);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.10);padding:40px 32px;max-width:480px;width:100%;text-align:center}.emoji{font-size:56px;margin-bottom:12px}h1{font-size:24px;color:#1e293b;margin-bottom:8px}p{color:#64748b;font-size:14px;margin-bottom:24px;line-height:1.6}.btn{display:block;padding:13px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:600;cursor:pointer;border:none;width:100%;margin-bottom:10px;color:#fff}.btn-primary{background:linear-gradient(135deg,#2563eb,#1d4ed8)}.btn-success{background:linear-gradient(135deg,#16a34a,#15803d)}.btn-gray{background:#64748b;font-size:13px}.status{padding:10px 16px;border-radius:8px;font-size:14px;margin-bottom:20px}.ok{background:#dcfce7;color:#15803d}.aviso{background:#fef3c7;color:#92400e;margin-bottom:16px;padding:12px;border-radius:8px;font-size:13px;text-align:left}</style></head><body><div class="card"><div class="emoji">📦</div><h1>Sugestão de Compra</h1><p>Integração com Tiny ERP via OAuth2 para sugestões de reposição por fornecedor.</p>${autenticado ? `<div class="status ok">✅ Autenticado com sucesso!</div><div class="aviso">⚠️ <strong>Atenção:</strong> A busca pode levar alguns minutos dependendo da quantidade de produtos, pois respeitamos os limites da API do Tiny.</div><a href="/api/sugestoes" class="btn btn-success">🔍 Gerar Sugestões de Compra</a><a href="/api/debug" class="btn btn-gray">🔧 Debug (ver estrutura)</a><a href="/logout" class="btn btn-gray">Sair</a>` : `<a href="/auth" class="btn btn-primary">🔐 Autenticar com Tiny ERP</a>`}</div></body></html>`);
});

// ── OAuth2 ────────────────────────────────────────────────────────────────────
app.get("/auth", (req, res) => {
  res.redirect(`${TINY_AUTH_URL}/auth?client_id=${TINY_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=openid`);
});

app.get("/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.status(400).send("Erro: " + (error || "sem código"));
  try {
    const r = await axios.post(`${TINY_AUTH_URL}/token`,
      new URLSearchParams({ grant_type: "authorization_code", client_id: TINY_CLIENT_ID, client_secret: TINY_CLIENT_SECRET, redirect_uri: REDIRECT_URI, code }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    req.session.access_token = r.data.access_token;
    req.session.refresh_token = r.data.refresh_token;
    req.session.token_expires = Date.now() + r.data.expires_in * 1000;
    res.redirect("/");
  } catch (e) {
    res.status(500).send("Erro token: " + JSON.stringify(e.response?.data || e.message));
  }
});

async function garantirToken(req) {
  if (!req.session.access_token) throw new Error("Não autenticado");
  if (Date.now() < req.session.token_expires - 30000) return req.session.access_token;
  const r = await axios.post(`${TINY_AUTH_URL}/token`,
    new URLSearchParams({ grant_type: "refresh_token", client_id: TINY_CLIENT_ID, client_secret: TINY_CLIENT_SECRET, refresh_token: req.session.refresh_token }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  req.session.access_token = r.data.access_token;
  req.session.refresh_token = r.data.refresh_token;
  req.session.token_expires = Date.now() + r.data.expires_in * 1000;
  return req.session.access_token;
}

// ── Busca produtos (saldo já vem no retorno) ──────────────────────────────────
async function buscarTodosProdutos(token) {
  let pagina = 1;
  let todos = [];
  while (true) {
    const data = await tinyGetSafe(token, "produtos", { pagina, situacao: "A", limite: 100 });
    const itens = data.itens || data.data || [];
    todos = todos.concat(itens);
    console.log(`Produtos p${pagina}: ${itens.length} itens`);
    if (itens.length < 100) break;
    pagina++;
  }
  return todos;
}

// ── Busca movimentações de saída ──────────────────────────────────────────────
async function buscarMovimentacoes(token) {
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - DIAS_ANALISE);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

  let pagina = 1;
  let todas = [];
  while (true) {
    try {
      const data = await tinyGetSafe(token, "movimentacoes-estoque", {
        pagina, dataInicial: fmt(inicio), dataFinal: fmt(hoje), tipo: "S", limite: 100
      });
      const itens = data.itens || data.data || [];
      todas = todas.concat(itens);
      console.log(`Movimentações p${pagina}: ${itens.length} itens`);
      if (itens.length < 100) break;
      pagina++;
    } catch (e) {
      console.error(`Erro movimentações p${pagina}:`, e.response?.status, e.response?.data);
      break;
    }
  }
  return todas;
}

// ── Calcula sugestões agrupadas por marca ─────────────────────────────────────
function calcularSugestoes(produtos, movimentacoes) {
  // Soma saídas por produto
  const saidasPorProduto = {};
  for (const mov of movimentacoes) {
    const id = mov.produto?.id || mov.idProduto || mov.produto_id;
    if (!id) continue;
    saidasPorProduto[id] = (saidasPorProduto[id] || 0) + Math.abs(parseFloat(mov.quantidade || 0));
  }

  const porMarca = {};
  for (const prod of produtos) {
    const marca = prod.marca || prod.nomeMarca || "Sem marca";
    if (!porMarca[marca]) porMarca[marca] = [];

    // Usa saldo que já vem no produto, sem requisição extra
    const estoqueAtual = parseFloat(
      prod.saldo ?? prod.estoque ?? prod.estoqueAtual ?? prod.saldoFisico ?? 0
    );
    const estoqueMin = parseFloat(prod.estoqueMinimo ?? prod.estoque_minimo ?? 0);
    const totalSaidas = saidasPorProduto[prod.id] || 0;
    const mediaDiaria = totalSaidas / DIAS_ANALISE;
    const necessario = Math.ceil(mediaDiaria * DIAS_COBERTURA);
    const precisaComprar = estoqueAtual < estoqueMin || estoqueAtual < necessario;
    const sugestao = Math.max(0, Math.ceil(necessario - estoqueAtual));

    if (precisaComprar) {
      porMarca[marca].push({
        id: prod.id,
        nome: prod.nome,
        sku: prod.codigo || prod.sku || "",
        estoqueAtual,
        estoqueMin,
        mediaDiaria: parseFloat(mediaDiaria.toFixed(2)),
        necessario,
        sugestao,
        abaixoMinimo: estoqueAtual < estoqueMin,
      });
    }
  }

  return Object.fromEntries(
    Object.entries(porMarca)
      .filter(([, ps]) => ps.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

// ── Debug: ver estrutura bruta ────────────────────────────────────────────────
app.get("/api/debug", async (req, res) => {
  try {
    const token = await garantirToken(req);
    const produtos = await tinyGetSafe(token, "produtos", { pagina: 1, limite: 2 });
    const hoje = new Date(); const inicio = new Date(); inicio.setDate(hoje.getDate() - 7);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    let movs = null;
    try {
      movs = await tinyGetSafe(token, "movimentacoes-estoque", { pagina: 1, limite: 2, dataInicial: fmt(inicio), dataFinal: fmt(hoje) });
    } catch(e) {
      movs = { erro: e.response?.status, msg: e.response?.data };
    }
    res.json({ ok: true, produtos, movimentacoes: movs });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message, detalhes: e.response?.data });
  }
});

// ── Sugestões ─────────────────────────────────────────────────────────────────
app.get("/api/sugestoes", async (req, res) => {
  try {
    const token = await garantirToken(req);
    console.log("Iniciando busca de produtos...");
    const produtos = await buscarTodosProdutos(token);
    console.log(`Total produtos: ${produtos.length}. Buscando movimentações...`);
    const movimentacoes = await buscarMovimentacoes(token);
    console.log(`Total movimentações: ${movimentacoes.length}. Calculando sugestões...`);

    const sugestoes = calcularSugestoes(produtos, movimentacoes);
    const marcas = Object.keys(sugestoes);
    const resumo = marcas.map((m) => ({
      marca: m,
      totalProdutos: sugestoes[m].length,
      totalUnidades: sugestoes[m].reduce((s, p) => s + p.sugestao, 0),
    }));

    res.json({
      ok: true,
      geradoEm: new Date().toISOString(),
      diasAnalise: DIAS_ANALISE,
      diasCobertura: DIAS_COBERTURA,
      totalProdutos: produtos.length,
      totalMovimentacoes: movimentacoes.length,
      totalMarcas: marcas.length,
      resumo,
      sugestoes,
    });
  } catch (e) {
    if (e.message === "Não autenticado") return res.status(401).json({ ok: false, erro: "Não autenticado." });
    console.error("Erro sugestões:", e.response?.data || e.message);
    res.status(500).json({ ok: false, erro: e.message, detalhes: e.response?.data });
  }
});

app.get("/logout", (req, res) => { req.session.destroy(); res.redirect("/"); });

app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
