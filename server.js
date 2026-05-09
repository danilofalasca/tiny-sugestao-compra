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
      await sleep(tentativa * 3000);
      return tinyGet(token, endpoint, params, tentativa + 1);
    }
    throw e;
  }
}

const CSS = `
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',sans-serif;background:#f0f4f8;min-height:100vh;padding:24px 16px}
    .card{background:#fff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,.08);padding:32px 28px;max-width:600px;margin:0 auto}
    .card-wide{max-width:860px}
    .emoji{font-size:48px;text-align:center;margin-bottom:12px}
    h1{font-size:22px;font-weight:700;color:#1e293b;text-align:center;margin-bottom:6px}
    h2{font-size:18px;font-weight:700;color:#1e293b;margin-bottom:6px}
    .sub{color:#64748b;font-size:14px;text-align:center;margin-bottom:24px;line-height:1.6}
    .info{background:#eff6ff;color:#1d4ed8;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:20px;line-height:1.6}
    .ok{background:#dcfce7;color:#15803d;border-radius:8px;padding:10px 14px;font-size:14px;margin-bottom:20px;text-align:center}
    .erro{background:#fee2e2;color:#dc2626;border-radius:8px;padding:12px 16px;font-size:13px;margin-bottom:16px}
    .btn{display:block;width:100%;padding:12px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px;text-decoration:none;text-align:center}
    .btn-blue{background:#2563eb;color:#fff}
    .btn-green{background:#16a34a;color:#fff}
    .btn-gray{background:#94a3b8;color:#fff;font-size:13px}
    .btn-sm{display:inline-block;width:auto;padding:8px 16px;font-size:13px}
    input[type=text]{width:100%;padding:10px 14px;border:1.5px solid #d1d5db;border-radius:8px;font-size:14px;outline:none;margin-bottom:12px}
    .lista{max-height:420px;overflow-y:auto;margin-bottom:16px}
    .marca-item{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;margin-bottom:6px;text-decoration:none;cursor:pointer;transition:background .15s}
    .marca-item:hover{background:#eff6ff;border-color:#bfdbfe}
    .marca-nome{font-size:14px;font-weight:600;color:#1e293b}
    .badge{font-size:12px;background:#dbeafe;color:#1d4ed8;border-radius:20px;padding:3px 12px;white-space:nowrap}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{background:#f1f5f9;padding:9px 12px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0;white-space:nowrap}
    td{padding:9px 12px;border-bottom:1px solid #f1f5f9;color:#1e293b}
    .tc{text-align:center}
    .tbl-wrap{overflow-x:auto;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:16px}
    .tag{background:#2563eb;color:#fff;border-radius:6px;padding:2px 9px;font-weight:700;font-size:12px}
    .tag-total{background:#1d4ed8;color:#fff;border-radius:6px;padding:2px 9px;font-weight:700;font-size:12px}
    .vermelho{color:#dc2626;font-weight:600}
    .verde{color:#16a34a;font-weight:600}
    .row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
    .voltar{background:none;border:none;font-size:22px;cursor:pointer;color:#64748b;padding:0 2px;line-height:1}
    .rodape{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
    .loader{text-align:center;padding:32px 0;color:#64748b;font-size:15px}
    .ok-grande{text-align:center;padding:32px 0;color:#16a34a}
  </style>
`;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "tiny-secret-key-2024",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));

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

async function garantirToken(req, res) {
  if (!req.session.access_token) { res.redirect("/auth"); return null; }
  if (Date.now() < req.session.token_expires - 30000) return req.session.access_token;
  try {
    const r = await axios.post(`${TINY_AUTH_URL}/token`,
      new URLSearchParams({ grant_type: "refresh_token", client_id: TINY_CLIENT_ID, client_secret: TINY_CLIENT_SECRET, refresh_token: req.session.refresh_token }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    req.session.access_token = r.data.access_token;
    req.session.refresh_token = r.data.refresh_token;
    req.session.token_expires = Date.now() + r.data.expires_in * 1000;
    return req.session.access_token;
  } catch(e) {
    res.redirect("/auth");
    return null;
  }
}

// ── Página inicial ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const auth = !!req.session.access_token;
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Sugestão de Compra</title>${CSS}</head><body>
    <div class="card">
      <div class="emoji">📦</div>
      <h1>Sugestão de Compra</h1>
      <p class="sub">Integração com Tiny ERP via OAuth2 para sugestões de reposição por fornecedor.</p>
      ${auth
        ? `<div class="ok">✅ Autenticado com sucesso!</div>
           <div class="info">📊 Analisa os últimos <strong>${DIAS_ANALISE} dias</strong> de movimentação e sugere quantidade para cobrir <strong>${DIAS_COBERTURA} dias</strong> de vendas.</div>
           <a href="/marcas" class="btn btn-green">🏷️ Ver Fornecedores</a>
           <a href="/logout" class="btn btn-gray">Sair</a>`
        : `<a href="/auth" class="btn btn-blue">🔐 Autenticar com Tiny ERP</a>`
      }
    </div>
  </body></html>`);
});

// ── Lista de marcas (HTML) ────────────────────────────────────────────────────
app.get("/marcas", async (req, res) => {
  const token = await garantirToken(req, res);
  if (!token) return;
  try {
    const data = await tinyGet(token, "marcas", { limite: 200 });
    const marcas = (data.itens || data.data || [])
      .map(m => ({ id: m.id, nome: m.nome || m.descricao || m.name }))
      .sort((a, b) => a.nome.localeCompare(b.nome));

    const itens = marcas.map(m =>
      `<a href="/sugestoes/${m.id}?nome=${encodeURIComponent(m.nome)}" class="marca-item">
        <span class="marca-nome">🏷️ ${m.nome}</span>
        <span class="badge">Gerar sugestão →</span>
      </a>`
    ).join("");

    res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Fornecedores</title>${CSS}</head><body>
      <div class="card">
        <div class="row"><a href="/" class="voltar">←</a><h2>Selecione o Fornecedor</h2></div>
        <p class="sub" style="text-align:left">${marcas.length} marcas encontradas</p>
        <input type="text" id="busca" placeholder="🔍 Buscar marca..." oninput="filtrar(this.value)"/>
        <div class="lista" id="lista">${itens}</div>
        <a href="/" class="btn btn-gray btn-sm">← Voltar</a>
      </div>
      <script>
        const todos = document.querySelectorAll('.marca-item');
        function filtrar(v) {
          todos.forEach(el => {
            el.style.display = el.querySelector('.marca-nome').textContent.toLowerCase().includes(v.toLowerCase()) ? '' : 'none';
          });
        }
      </script>
    </body></html>`);
  } catch (e) {
    res.send(`<!DOCTYPE html><html><head>${CSS}</head><body><div class="card"><div class="erro">Erro ao carregar marcas: ${e.message}</div><a href="/" class="btn btn-gray btn-sm">← Voltar</a></div></body></html>`);
  }
});

// ── Sugestões de uma marca (HTML) ─────────────────────────────────────────────
app.get("/sugestoes/:marcaId", async (req, res) => {
  const token = await garantirToken(req, res);
  if (!token) return;

  const { marcaId } = req.params;
  const nomeMarca = req.query.nome || marcaId;

  // Mostra página de loading e busca via JS
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${nomeMarca}</title>${CSS}</head><body>
    <div class="card card-wide" id="conteudo">
      <div class="loader">
        <div style="font-size:48px;margin-bottom:16px">⏳</div>
        <p style="font-weight:600;font-size:16px;margin-bottom:8px">Gerando sugestão...</p>
        <p>Buscando produtos e movimentações de <strong>${nomeMarca}</strong> nos últimos ${DIAS_ANALISE} dias.</p>
      </div>
    </div>
    <script>
      fetch('/api/sugestoes/${marcaId}?nome=${encodeURIComponent(nomeMarca)}')
        .then(r => r.json())
        .then(data => {
          if (!data.ok) { document.getElementById('conteudo').innerHTML = '<div class="erro">Erro: ' + data.erro + '</div><a href="/marcas" class="btn btn-gray btn-sm">← Voltar</a>'; return; }
          const prods = data.produtos || [];
          const total = data.totalUnidades || 0;
          let html = '<div class="row"><a href="/marcas" class="voltar">←</a><h2>🏷️ ${nomeMarca}</h2></div>';
          html += '<p class="sub" style="text-align:left">' + prods.length + ' produto(s) para repor · cobertura ${DIAS_COBERTURA} dias · base ${DIAS_ANALISE} dias</p>';
          if (prods.length === 0) {
            html += '<div class="ok-grande"><div style="font-size:40px;margin-bottom:8px">✅</div><p style="font-weight:600">Estoque em dia! Nenhum produto precisa de reposição.</p></div>';
          } else {
            let linhas = prods.map((p, i) =>
              '<tr style="background:' + (i%2===0?'#f9fafb':'#fff') + '">' +
              '<td><code style="font-size:11px;color:#64748b">' + (p.sku||'-') + '</code></td>' +
              '<td style="font-weight:500">' + p.nome + '</td>' +
              '<td class="tc ' + (p.abaixoMinimo?'vermelho':'verde') + '">' + p.estoqueAtual + (p.abaixoMinimo?' ⚠️':'') + '</td>' +
              '<td class="tc">' + p.estoqueMin + '</td>' +
              '<td class="tc">' + p.mediaDiaria + '</td>' +
              '<td class="tc">' + p.necessario + '</td>' +
              '<td class="tc"><span class="tag">' + p.sugestao + ' un</span></td>' +
              '</tr>'
            ).join('');
            html += '<div class="tbl-wrap"><table><thead><tr><th>SKU</th><th>Produto</th><th>Estoque</th><th>Mín.</th><th>Média/dia</th><th>Necessário</th><th>Sugestão</th></tr></thead><tbody>' + linhas + '</tbody>';
            html += '<tfoot><tr style="background:#f1f5f9"><td colspan="6" style="text-align:right;font-weight:700;padding:9px 12px;font-size:13px">Total a pedir:</td><td class="tc"><span class="tag-total">' + total + ' un</span></td></tr></tfoot></table></div>';
          }
          html += '<div class="rodape"><a href="/marcas" class="btn btn-gray btn-sm">← Outros fornecedores</a>';
          if (prods.length > 0) html += '<button class="btn btn-blue btn-sm" onclick="copiar(data)">📋 Copiar tabela</button>';
          html += '</div>';
          document.getElementById('conteudo').innerHTML = html;
          window._data = data;
        })
        .catch(e => {
          document.getElementById('conteudo').innerHTML = '<div class="erro">Erro: ' + e.message + '</div><a href="/marcas" class="btn btn-gray btn-sm">← Voltar</a>';
        });

      function copiar(data) {
        const prods = data.produtos || [];
        const csv = ["SKU\\tProduto\\tEstoque\\tMínimo\\tMédia/dia\\tNecessário\\tSugestão",
          ...prods.map(p => p.sku + "\\t" + p.nome + "\\t" + p.estoqueAtual + "\\t" + p.estoqueMin + "\\t" + p.mediaDiaria + "\\t" + p.necessario + "\\t" + p.sugestao)
        ].join("\\n");
        navigator.clipboard.writeText(csv).then(() => alert("Tabela copiada!"));
      }
    </script>
  </body></html>`);
});

// ── API JSON (usada internamente pela página de sugestões) ────────────────────
app.get("/api/sugestoes/:marcaId", async (req, res) => {
  try {
    if (!req.session.access_token) return res.status(401).json({ ok: false, erro: "Não autenticado." });
    const token = req.session.access_token;
    const { marcaId } = req.params;
    const nomeMarca = req.query.nome || marcaId;

    const hoje = new Date(), inicio = new Date();
    inicio.setDate(hoje.getDate() - DIAS_ANALISE);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

    // Busca produtos da marca
    let pagina = 1, produtos = [];
    while (true) {
      const data = await tinyGet(token, "produtos", { pagina, situacao: "A", idMarca: marcaId, limite: 100 });
      const itens = data.itens || data.data || [];
      produtos = produtos.concat(itens);
      if (itens.length < 100) break;
      pagina++;
    }

    // Busca movimentações da marca
    pagina = 1;
    let movimentacoes = [];
    while (true) {
      try {
        const data = await tinyGet(token, "movimentacoes-estoque", { pagina, dataInicial: fmt(inicio), dataFinal: fmt(hoje), tipo: "S", idMarca: marcaId, limite: 100 });
        const itens = data.itens || data.data || [];
        movimentacoes = movimentacoes.concat(itens);
        if (itens.length < 100) break;
        pagina++;
      } catch(e) { break; }
    }

    // Calcula sugestões
    const saidas = {};
    for (const mov of movimentacoes) {
      const id = mov.produto?.id || mov.idProduto || mov.produto_id;
      if (id) saidas[id] = (saidas[id] || 0) + Math.abs(parseFloat(mov.quantidade || 0));
    }

    const sugestoes = produtos.map(prod => {
      const estoqueAtual = parseFloat(prod.saldo ?? prod.estoque ?? prod.saldoFisico ?? 0);
      const estoqueMin = parseFloat(prod.estoqueMinimo ?? prod.estoque_minimo ?? 0);
      const mediaDiaria = (saidas[prod.id] || 0) / DIAS_ANALISE;
      const necessario = Math.ceil(mediaDiaria * DIAS_COBERTURA);
      const precisaComprar = estoqueAtual < estoqueMin || estoqueAtual < necessario;
      const sugestao = Math.max(0, Math.ceil(necessario - estoqueAtual));
      return { id: prod.id, nome: prod.nome, sku: prod.codigo || "", estoqueAtual, estoqueMin, mediaDiaria: parseFloat(mediaDiaria.toFixed(2)), necessario, sugestao, precisaComprar, abaixoMinimo: estoqueAtual < estoqueMin };
    }).filter(p => p.precisaComprar);

    res.json({ ok: true, marca: nomeMarca, marcaId, diasAnalise: DIAS_ANALISE, diasCobertura: DIAS_COBERTURA, totalProdutos: produtos.length, totalParaRepor: sugestoes.length, totalUnidades: sugestoes.reduce((s,p) => s+p.sugestao, 0), produtos: sugestoes });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message, detalhes: e.response?.data });
  }
});

app.get("/logout", (req, res) => { req.session.destroy(); res.redirect("/"); });

app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
