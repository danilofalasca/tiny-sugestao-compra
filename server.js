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

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "tiny-secret-key-2024",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  })
);

app.get("/", (req, res) => {
  const autenticado = !!req.session.access_token;
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Sugestão de Compra</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#eff6ff,#f0fdf4);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.10);padding:40px 32px;max-width:440px;width:100%;text-align:center}.emoji{font-size:56px;margin-bottom:12px}h1{font-size:24px;color:#1e293b;margin-bottom:8px}p{color:#64748b;font-size:15px;margin-bottom:28px;line-height:1.5}.btn{display:block;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:16px;font-weight:600;cursor:pointer;border:none;width:100%;margin-bottom:10px;color:#fff}.btn-primary{background:linear-gradient(135deg,#2563eb,#1d4ed8)}.btn-success{background:linear-gradient(135deg,#16a34a,#15803d)}.btn-secondary{background:#64748b;font-size:14px}.status{padding:10px 16px;border-radius:8px;font-size:14px;margin-bottom:20px}.status.ok{background:#dcfce7;color:#15803d}</style></head><body><div class="card"><div class="emoji">📦</div><h1>Sugestão de Compra</h1><p>Integração com Tiny ERP via OAuth2 para sugestões de reposição por fornecedor.</p>${autenticado?`<div class="status ok">✅ Autenticado com sucesso!</div><a href="/api/sugestoes" class="btn btn-success">🔍 Ver Sugestões (JSON)</a><a href="/api/debug" class="btn btn-secondary">🔧 Debug API</a><a href="/logout" class="btn btn-secondary">Sair</a>`:`<a href="/auth" class="btn btn-primary">🔐 Autenticar com Tiny ERP</a>`}</div></body></html>`);
});

app.get("/auth", (req, res) => {
  const authUrl = `${TINY_AUTH_URL}/auth?client_id=${TINY_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=openid`;
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.status(400).send("Erro na autenticação: " + (error || "código não recebido"));
  try {
    const tokenRes = await axios.post(`${TINY_AUTH_URL}/token`,
      new URLSearchParams({ grant_type: "authorization_code", client_id: TINY_CLIENT_ID, client_secret: TINY_CLIENT_SECRET, redirect_uri: REDIRECT_URI, code }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    req.session.access_token = tokenRes.data.access_token;
    req.session.refresh_token = tokenRes.data.refresh_token;
    req.session.token_expires = Date.now() + tokenRes.data.expires_in * 1000;
    res.redirect("/");
  } catch (e) {
    console.error("Erro callback:", e.response?.data || e.message);
    res.status(500).send("Erro ao obter token: " + JSON.stringify(e.response?.data || e.message));
  }
});

async function garantirToken(req) {
  if (!req.session.access_token) throw new Error("Não autenticado");
  if (Date.now() < req.session.token_expires - 30000) return req.session.access_token;
  const refreshRes = await axios.post(`${TINY_AUTH_URL}/token`,
    new URLSearchParams({ grant_type: "refresh_token", client_id: TINY_CLIENT_ID, client_secret: TINY_CLIENT_SECRET, refresh_token: req.session.refresh_token }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  req.session.access_token = refreshRes.data.access_token;
  req.session.refresh_token = refreshRes.data.refresh_token;
  req.session.token_expires = Date.now() + refreshRes.data.expires_in * 1000;
  return req.session.access_token;
}

async function tinyGet(token, endpoint, params = {}) {
  const res = await axios.get(`${TINY_API_V3}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  return res.data;
}

async function buscarTodosProdutos(token) {
  let pagina = 1;
  let todos = [];
  while (true) {
    const data = await tinyGet(token, "produtos", { pagina, situacao: "A", limite: 100 });
    const itens = data.itens || data.data || [];
    todos = todos.concat(itens);
    if (itens.length < 100) break;
    pagina++;
  }
  return todos;
}

async function buscarMovimentacoes(token, diasAtras) {
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - diasAtras);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  let pagina = 1;
  let todas = [];
  while (true) {
    try {
      const data = await tinyGet(token, "movimentacoes-estoque", { pagina, dataInicial: fmt(inicio), dataFinal: fmt(hoje), tipo: "S", limite: 100 });
      const itens = data.itens || data.data || [];
      todas = todas.concat(itens);
      if (itens.length < 100) break;
      pagina++;
    } catch (e) {
      console.error("Erro movimentações p" + pagina + ":", e.response?.status, JSON.stringify(e.response?.data));
      break;
    }
  }
  return todas;
}

async function buscarEstoqueProduto(token, prodId) {
  try {
    const data = await tinyGet(token, `produtos/${prodId}/estoque`);
    const saldo = data.saldo ?? data.estoqueAtual ?? data.estoque ?? data.data?.saldo ?? 0;
    return parseFloat(saldo);
  } catch (e) {
    return null;
  }
}

function calcularSugestoes(produtos, movimentacoes, estoques) {
  const saidasPorProduto = {};
  for (const mov of movimentacoes) {
    const id = mov.produto?.id || mov.idProduto || mov.produto_id;
    if (!id) continue;
    if (!saidasPorProduto[id]) saidasPorProduto[id] = 0;
    saidasPorProduto[id] += Math.abs(parseFloat(mov.quantidade || 0));
  }

  const porMarca = {};
  for (const prod of produtos) {
    const marca = prod.marca || prod.nomeMarca || "Sem marca";
    if (!porMarca[marca]) porMarca[marca] = [];
    const totalSaidas = saidasPorProduto[prod.id] || 0;
    const mediaDiaria = totalSaidas / DIAS_ANALISE;
    const estoqueAtual = estoques[prod.id] ?? parseFloat(prod.saldo ?? prod.estoque ?? 0);
    const estoqueMin = parseFloat(prod.estoqueMinimo ?? prod.estoque_minimo ?? 0);
    const necessario = Math.ceil(mediaDiaria * DIAS_COBERTURA);
    const precisaComprar = estoqueAtual < estoqueMin || estoqueAtual < necessario;
    const sugestao = Math.max(0, Math.ceil(necessario - estoqueAtual));
    if (precisaComprar) {
      porMarca[marca].push({ id: prod.id, nome: prod.nome, sku: prod.codigo || prod.sku || "", estoqueAtual, estoqueMin, mediaDiaria: parseFloat(mediaDiaria.toFixed(2)), necessario, sugestao, abaixoMinimo: estoqueAtual < estoqueMin });
    }
  }
  return Object.fromEntries(Object.entries(porMarca).filter(([,ps]) => ps.length > 0).sort(([a],[b]) => a.localeCompare(b)));
}

// Debug: ver estrutura bruta da API
app.get("/api/debug", async (req, res) => {
  try {
    const token = await garantirToken(req);
    const produtos = await tinyGet(token, "produtos", { pagina: 1, limite: 2 });
    let estoque = null;
    const itens = produtos.itens || produtos.data || [];
    if (itens.length > 0) {
      try { estoque = await tinyGet(token, `produtos/${itens[0].id}/estoque`); } catch(e) { estoque = { erro: e.response?.status, msg: e.response?.data }; }
    }
    let movimentacoes = null;
    const hoje = new Date(); const inicio = new Date(); inicio.setDate(hoje.getDate() - 7);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    try { movimentacoes = await tinyGet(token, "movimentacoes-estoque", { pagina: 1, limite: 2, dataInicial: fmt(inicio), dataFinal: fmt(hoje) }); } catch(e) { movimentacoes = { erro: e.response?.status, msg: e.response?.data }; }
    res.json({ ok: true, produtos_estrutura: produtos, estoque_estrutura: estoque, movimentacoes_estrutura: movimentacoes });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message, detalhes: e.response?.data });
  }
});

app.get("/api/sugestoes", async (req, res) => {
  try {
    const token = await garantirToken(req);
    const [produtos, movimentacoes] = await Promise.all([
      buscarTodosProdutos(token),
      buscarMovimentacoes(token, DIAS_ANALISE),
    ]);

    // Busca estoque em lotes de 10
    const estoques = {};
    for (let i = 0; i < produtos.length; i += 10) {
      const lote = produtos.slice(i, i + 10);
      await Promise.all(lote.map(async (prod) => {
        const saldo = await buscarEstoqueProduto(token, prod.id);
        estoques[prod.id] = saldo ?? parseFloat(prod.saldo ?? prod.estoque ?? 0);
      }));
    }

    const sugestoes = calcularSugestoes(produtos, movimentacoes, estoques);
    const marcas = Object.keys(sugestoes);
    const resumo = marcas.map((m) => ({ marca: m, totalProdutos: sugestoes[m].length, totalUnidades: sugestoes[m].reduce((s,p) => s+p.sugestao, 0) }));

    res.json({ ok: true, geradoEm: new Date().toISOString(), diasAnalise: DIAS_ANALISE, diasCobertura: DIAS_COBERTURA, totalProdutos: produtos.length, totalMarcas: marcas.length, resumo, sugestoes });
  } catch (e) {
    if (e.message === "Não autenticado") return res.status(401).json({ ok: false, erro: "Não autenticado." });
    console.error("Erro:", e.response?.data || e.message);
    res.status(500).json({ ok: false, erro: e.message, detalhes: e.response?.data });
  }
});

app.get("/logout", (req, res) => { req.session.destroy(); res.redirect("/"); });

app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
