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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Requisição com retry automático em caso de rate limit ─────────────────────
async function tinyGet(token, endpoint, params = {}, tentativa = 1) {
  try {
    await sleep(400);
    const res = await axios.get(`${TINY_API_V3}/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });
    return res.data;
  } catch (e) {
    if (e.response?.status === 429 && tentativa <= 4) {
      const espera = tentativa * 3000;
      console.log(`Rate limit, aguardando ${espera/1000}s... (tentativa ${tentativa})`);
      await sleep(espera);
      return tinyGet(token, endpoint, params, tentativa + 1);
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

// ── OAuth2 ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const autenticado = !!req.session.access_token;
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Sugestão de Compra</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#eff6ff,#f0fdf4);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.10);padding:40px 32px;max-width:480px;width:100%;text-align:center}.emoji{font-size:56px;margin-bottom:12px}h1{font-size:24px;color:#1e293b;margin-bottom:8px}p{color:#64748b;font-size:14px;margin-bottom:24px;line-height:1.6}.btn{display:block;padding:13px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:600;cursor:pointer;border:none;width:100%;margin-bottom:10px;color:#fff}.btn-primary{background:linear-gradient(135deg,#2563eb,#1d4ed8)}.btn-success{background:linear-gradient(135deg,#16a34a,#15803d)}.btn-gray{background:#64748b;font-size:13px}.status{padding:10px 16px;border-radius:8px;font-size:14px;margin-bottom:20px}.ok{background:#dcfce7;color:#15803d}</style></head><body><div class="card"><div class="emoji">📦</div><h1>Sugestão de Compra</h1><p>Integração com Tiny ERP via OAuth2.</p>${autenticado
    ? `<div class="status ok">✅ Autenticado!</div>
       <a href="/api/marcas" class="btn btn-success">🏷️ Ver Marcas Disponíveis</a>
       <a href="/api/debug" class="btn btn-gray">🔧 Debug</a>
       <a href="/logout" class="btn btn-gray">Sair</a>`
    : `<a href="/auth" class="btn btn-primary">🔐 Autenticar com Tiny ERP</a>`
  }</div></body></html>`);
});

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

// ── Busca marcas cadastradas no Tiny ─────────────────────────────────────────
app.get("/api/marcas", async (req, res) => {
  try {
    const token = await garantirToken(req);
    const data = await tinyGet(token, "marcas", { limite: 100 });
    const marcas = (data.itens || data.data || []).map((m) => ({
      id: m.id,
      nome: m.nome || m.descricao || m.name,
    }));
    res.json({ ok: true, total: marcas.length, marcas });
  } catch (e) {
    if (e.message === "Não autenticado") return res.status(401).json({ ok: false, erro: "Não autenticado." });
    res.status(500).json({ ok: false, erro: e.message, detalhes: e.response?.data });
  }
});

// ── Busca produtos de UMA marca específica ────────────────────────────────────
async function buscarProdutosDaMarca(token, marcaId) {
  let pagina = 1;
  let todos = [];
  while (true) {
    const data = await tinyGet(token, "produtos", {
      pagina,
      situacao: "A",
      limite: 100,
      idMarca: marcaId, // filtra direto pela marca na API
    });
    const itens = data.itens || data.data || [];
    todos = todos.concat(itens);
    console.log(`Marca ${marcaId} p${pagina}: ${itens.length} produtos`);
    if (itens.length < 100) break;
    pagina++;
  }
  return todos;
}

// ── Busca movimentações de saída dos últimos N dias ───────────────────────────
async function buscarMovimentacoesDaMarca(token, marcaId) {
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - DIAS_ANALISE);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

  let pagina = 1;
  let todas = [];
  while (true) {
    try {
      const data = await tinyGet(token, "movimentacoes-estoque", {
        pagina,
        dataInicial: fmt(inicio),
        dataFinal: fmt(hoje),
        tipo: "S",
        idMarca: marcaId,
        limite: 100,
      });
      const itens = data.itens || data.data || [];
      todas = todas.concat(itens);
      console.log(`Movimentações marca ${marcaId} p${pagina}: ${itens.length}`);
      if (itens.length < 100) break;
      pagina++;
    } catch (e) {
      console.error("Erro movimentações:", e.response?.status, e.response?.data);
      // Se idMarca não for suportado no endpoint de movimentações, busca sem filtro
      // e filtra localmente depois
      break;
    }
  }
  return todas;
}

// ── Calcula sugestões para os produtos de uma marca ───────────────────────────
function calcularSugestoesMarca(produtos, movimentacoes) {
  const saidasPorProduto = {};
  for (const mov of movimentacoes) {
    const id = mov.produto?.id || mov.idProduto || mov.produto_id;
    if (!id) continue;
    saidasPorProduto[id] = (saidasPorProduto[id] || 0) + Math.abs(parseFloat(mov.quantidade || 0));
  }

  return produtos.map((prod) => {
    const estoqueAtual = parseFloat(prod.saldo ?? prod.estoque ?? prod.saldoFisico ?? 0);
    const estoqueMin = parseFloat(prod.estoqueMinimo ?? prod.estoque_minimo ?? 0);
    const totalSaidas = saidasPorProduto[prod.id] || 0;
    const mediaDiaria = totalSaidas / DIAS_ANALISE;
    const necessario = Math.ceil(mediaDiaria * DIAS_COBERTURA);
    const precisaComprar = estoqueAtual < estoqueMin || estoqueAtual < necessario;
    const sugestao = Math.max(0, Math.ceil(necessario - estoqueAtual));

    return {
      id: prod.id,
      nome: prod.nome,
      sku: prod.codigo || prod.sku || "",
      estoqueAtual,
      estoqueMin,
      mediaDiaria: parseFloat(mediaDiaria.toFixed(2)),
      necessario,
      sugestao,
      precisaComprar,
      abaixoMinimo: estoqueAtual < estoqueMin,
    };
  }).filter((p) => p.precisaComprar);
}

// ── Endpoint: sugestões de UMA marca ─────────────────────────────────────────
// GET /api/sugestoes/:marcaId
app.get("/api/sugestoes/:marcaId", async (req, res) => {
  try {
    const token = await garantirToken(req);
    const { marcaId } = req.params;
    const nomeMarca = req.query.nome || marcaId;

    console.log(`Buscando produtos da marca ${marcaId}...`);
    const [produtos, movimentacoes] = await Promise.all([
      buscarProdutosDaMarca(token, marcaId),
      buscarMovimentacoesDaMarca(token, marcaId),
    ]);

    console.log(`Produtos: ${produtos.length} | Movimentações: ${movimentacoes.length}`);
    const sugestoes = calcularSugestoesMarca(produtos, movimentacoes);
    const totalUnidades = sugestoes.reduce((s, p) => s + p.sugestao, 0);

    res.json({
      ok: true,
      marca: nomeMarca,
      marcaId,
      geradoEm: new Date().toISOString(),
      diasAnalise: DIAS_ANALISE,
      diasCobertura: DIAS_COBERTURA,
      totalProdutos: produtos.length,
      totalParaRepor: sugestoes.length,
      totalUnidades,
      produtos: sugestoes,
    });
  } catch (e) {
    if (e.message === "Não autenticado") return res.status(401).json({ ok: false, erro: "Não autenticado." });
    console.error("Erro:", e.response?.data || e.message);
    res.status(500).json({ ok: false, erro: e.message, detalhes: e.response?.data });
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────────
app.get("/api/debug", async (req, res) => {
  try {
    const token = await garantirToken(req);
    const produtos = await tinyGet(token, "produtos", { pagina: 1, limite: 2 });
    const marcas = await tinyGet(token, "marcas", { limite: 5 });
    const hoje = new Date(); const inicio = new Date(); inicio.setDate(hoje.getDate() - 7);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    let movs = null;
    try {
      movs = await tinyGet(token, "movimentacoes-estoque", { pagina: 1, limite: 2, dataInicial: fmt(inicio), dataFinal: fmt(hoje) });
    } catch(e) {
      movs = { erro: e.response?.status, msg: e.response?.data };
    }
    res.json({ ok: true, produtos_amostra: produtos, marcas_amostra: marcas, movimentacoes_amostra: movs });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message, detalhes: e.response?.data });
  }
});

app.get("/logout", (req, res) => { req.session.destroy(); res.redirect("/"); });

app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
