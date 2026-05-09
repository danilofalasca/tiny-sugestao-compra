require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const session = require("express-session");
const cron = require("node-cron");
const { Pool } = require("pg");

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

// ── Banco de dados ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendas_sku (
      sku TEXT PRIMARY KEY,
      nome TEXT,
      quantidade INTEGER DEFAULT 0,
      atualizado TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id SERIAL PRIMARY KEY,
      iniciou TIMESTAMP,
      terminou TIMESTAMP,
      total_pedidos INTEGER DEFAULT 0,
      total_itens INTEGER DEFAULT 0,
      status TEXT,
      mensagem TEXT
    );
    CREATE TABLE IF NOT EXISTS tokens_sync (
      id INTEGER PRIMARY KEY DEFAULT 1,
      access_token TEXT,
      refresh_token TEXT,
      expires_at BIGINT
    );
  `);
  console.log("✅ Banco iniciado");
}

// ── Rate limit seguro ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tinyGet(token, endpoint, params = {}, tentativa = 1) {
  try {
    await sleep(600);
    const res = await axios.get(`${TINY_API_V3}/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });
    return res.data;
  } catch (e) {
    if (e.response?.status === 429 && tentativa <= 5) {
      const espera = tentativa * 5000;
      console.log(`Rate limit em ${endpoint}, aguardando ${espera/1000}s... (tentativa ${tentativa})`);
      await sleep(espera);
      return tinyGet(token, endpoint, params, tentativa + 1);
    }
    throw e;
  }
}

// ── OAuth2 ────────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "tiny-secret-2024",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));

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

    // Salva token no banco para uso do cron job
    await pool.query(`
      INSERT INTO tokens_sync (id, access_token, refresh_token, expires_at)
      VALUES (1, $1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET access_token=$1, refresh_token=$2, expires_at=$3
    `, [r.data.access_token, r.data.refresh_token, Date.now() + r.data.expires_in * 1000]);

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
    await pool.query(`
      INSERT INTO tokens_sync (id, access_token, refresh_token, expires_at)
      VALUES (1, $1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET access_token=$1, refresh_token=$2, expires_at=$3
    `, [r.data.access_token, r.data.refresh_token, Date.now() + r.data.expires_in * 1000]);
    return req.session.access_token;
  } catch(e) { res.redirect("/auth"); return null; }
}

async function obterTokenSalvo() {
  const res = await pool.query("SELECT * FROM tokens_sync WHERE id=1");
  if (!res.rows[0]) return null;
  const t = res.rows[0];

  if (Date.now() < t.expires_at - 30000) return t.access_token;

  // Refresh automático
  const r = await axios.post(`${TINY_AUTH_URL}/token`,
    new URLSearchParams({ grant_type: "refresh_token", client_id: TINY_CLIENT_ID, client_secret: TINY_CLIENT_SECRET, refresh_token: t.refresh_token }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  await pool.query(`
    UPDATE tokens_sync SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE id=1
  `, [r.data.access_token, r.data.refresh_token, Date.now() + r.data.expires_in * 1000]);
  return r.data.access_token;
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#f0f4f8;min-height:100vh;padding:24px 16px}
.card{background:#fff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,.08);padding:32px 28px;max-width:640px;margin:0 auto}
.card-wide{max-width:920px}
.emoji{font-size:48px;text-align:center;margin-bottom:12px}
h1{font-size:22px;font-weight:700;color:#1e293b;text-align:center;margin-bottom:6px}
h2{font-size:18px;font-weight:700;color:#1e293b;margin-bottom:4px}
.sub{color:#64748b;font-size:13px;margin-bottom:20px;line-height:1.6}
.sub-c{text-align:center}
.info{background:#eff6ff;color:#1d4ed8;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px;line-height:1.6}
.ok{background:#dcfce7;color:#15803d;border-radius:8px;padding:10px 14px;font-size:14px;margin-bottom:16px;text-align:center}
.warn{background:#fef3c7;color:#92400e;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px}
.erro{background:#fee2e2;color:#dc2626;border-radius:8px;padding:12px 16px;font-size:13px;margin-bottom:16px;word-break:break-word}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px;text-decoration:none;text-align:center}
.btn-blue{background:#2563eb;color:#fff}
.btn-green{background:#16a34a;color:#fff}
.btn-orange{background:#ea580c;color:#fff}
.btn-gray{background:#94a3b8;color:#fff;font-size:13px}
.btn-sm{display:inline-block;width:auto;padding:8px 16px;font-size:13px;margin-bottom:0}
input[type=text]{width:100%;padding:10px 14px;border:1.5px solid #d1d5db;border-radius:8px;font-size:14px;outline:none;margin-bottom:12px}
.lista{max-height:460px;overflow-y:auto;margin-bottom:16px}
.marca-item{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;margin-bottom:6px;text-decoration:none;transition:background .15s}
.marca-item:hover{background:#eff6ff;border-color:#bfdbfe}
.marca-nome{font-size:14px;font-weight:600;color:#1e293b}
.badge{font-size:12px;background:#dbeafe;color:#1d4ed8;border-radius:20px;padding:3px 12px;white-space:nowrap}
.badge-warn{background:#fef3c7;color:#92400e}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f1f5f9;padding:9px 12px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0;white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid #f1f5f9;color:#1e293b}
.tc{text-align:center}
.tbl-wrap{overflow-x:auto;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:16px}
.tag{background:#2563eb;color:#fff;border-radius:6px;padding:2px 9px;font-weight:700;font-size:12px}
.tag-warn{background:#ea580c;color:#fff;border-radius:6px;padding:2px 9px;font-weight:700;font-size:12px}
.tag-total{background:#1d4ed8;color:#fff;border-radius:6px;padding:2px 9px;font-weight:700;font-size:12px}
.vermelho{color:#dc2626;font-weight:600}
.verde{color:#16a34a;font-weight:600}
.laranja{color:#ea580c;font-weight:600}
.row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.voltar{background:none;border:none;font-size:22px;cursor:pointer;color:#64748b;padding:0 2px;text-decoration:none;line-height:1}
.rodape{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.loader{text-align:center;padding:32px 0;color:#64748b}
.ok-grande{text-align:center;padding:32px 0;color:#16a34a}
.spinner{display:inline-block;width:36px;height:36px;border:4px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:16px}
@keyframes spin{to{transform:rotate(360deg)}}
.status-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:13px}
.status-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f1f5f9}
.status-row:last-child{border-bottom:none}
</style>`;

// ── Página inicial ─────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  const auth = !!req.session.access_token;
  let syncInfo = null;
  try {
    const r = await pool.query("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1");
    if (r.rows[0]) syncInfo = r.rows[0];
  } catch(e) {}

  const syncStatus = syncInfo
    ? `<div class="status-box">
        <div class="status-row"><span>Última sincronização</span><strong>${syncInfo.terminou ? new Date(syncInfo.terminou).toLocaleString("pt-BR") : "Em andamento..."}</strong></div>
        <div class="status-row"><span>Pedidos processados</span><strong>${syncInfo.total_pedidos?.toLocaleString("pt-BR") || 0}</strong></div>
        <div class="status-row"><span>SKUs únicos</span><strong>${syncInfo.total_itens?.toLocaleString("pt-BR") || 0}</strong></div>
        <div class="status-row"><span>Status</span><strong style="color:${syncInfo.status==='ok'?'#16a34a':'#dc2626'}">${syncInfo.status === 'ok' ? '✅ Concluído' : '⚠️ ' + syncInfo.status}</strong></div>
       </div>`
    : `<div class="warn">⚠️ Nenhuma sincronização encontrada. Clique em "Sincronizar Agora" para iniciar.</div>`;

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Sugestão de Compra</title>${CSS}</head><body>
    <div class="card">
      <div class="emoji">📦</div>
      <h1>Sugestão de Compra</h1>
      <p class="sub sub-c">Tiny ERP · OAuth2 · Sync automático toda madrugada</p>
      ${auth
        ? `<div class="ok">✅ Autenticado com sucesso!</div>
           ${syncStatus}
           <a href="/marcas" class="btn btn-green">🏷️ Ver Fornecedores</a>
           <a href="/sincronizar" class="btn btn-orange">🔄 Sincronizar Agora</a>
           <a href="/logout" class="btn btn-gray">Sair</a>`
        : `<div class="info">Faça login com sua conta do Tiny ERP para continuar.</div>
           <a href="/auth" class="btn btn-blue">🔐 Autenticar com Tiny ERP</a>`}
    </div>
  </body></html>`);
});

// ── Sincronização manual ──────────────────────────────────────────────────────
app.get("/sincronizar", async (req, res) => {
  const token = await garantirToken(req, res);
  if (!token) return;
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Sincronizando</title>${CSS}
  <meta http-equiv="refresh" content="5;url=/status-sync"></head><body>
    <div class="card" style="text-align:center">
      <div style="font-size:48px;margin-bottom:16px">🔄</div>
      <h1>Sincronizando...</h1>
      <p class="sub sub-c">Buscando todos os pedidos dos últimos ${DIAS_ANALISE} dias.<br>Isso pode levar alguns minutos.</p>
      <p style="font-size:12px;color:#94a3b8;margin-top:8px">Você será redirecionado automaticamente.</p>
    </div>
  </body></html>`);
  // Inicia sync em background
  sincronizarVendas(token).catch(e => console.error("Erro sync:", e.message));
});

app.get("/status-sync", async (req, res) => {
  const r = await pool.query("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1");
  const s = r.rows[0];
  const emAndamento = s && !s.terminou;
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Status Sync</title>${CSS}
  ${emAndamento ? '<meta http-equiv="refresh" content="10">' : ''}</head><body>
    <div class="card">
      <h1>${emAndamento ? "⏳ Sincronizando..." : "✅ Sincronização concluída"}</h1>
      ${s ? `<div class="status-box">
        <div class="status-row"><span>Iniciou</span><strong>${new Date(s.iniciou).toLocaleString("pt-BR")}</strong></div>
        <div class="status-row"><span>Terminou</span><strong>${s.terminou ? new Date(s.terminou).toLocaleString("pt-BR") : "Em andamento..."}</strong></div>
        <div class="status-row"><span>Pedidos</span><strong>${s.total_pedidos?.toLocaleString("pt-BR") || 0}</strong></div>
        <div class="status-row"><span>SKUs únicos</span><strong>${s.total_itens?.toLocaleString("pt-BR") || 0}</strong></div>
        <div class="status-row"><span>Status</span><strong>${s.status}</strong></div>
        ${s.mensagem ? `<div class="status-row"><span>Detalhe</span><strong>${s.mensagem}</strong></div>` : ""}
      </div>` : ""}
      ${emAndamento
        ? `<p class="sub sub-c">Esta página atualiza a cada 10 segundos automaticamente.</p>`
        : `<a href="/" class="btn btn-green">← Voltar ao início</a>`}
    </div>
  </body></html>`);
});

// ── Lógica de sincronização ───────────────────────────────────────────────────
async function sincronizarVendas(token) {
  const iniciou = new Date();
  const logRes = await pool.query(
    "INSERT INTO sync_log (iniciou, status) VALUES ($1, $2) RETURNING id",
    [iniciou, "em andamento"]
  );
  const logId = logRes.rows[0].id;

  try {
    const hoje = new Date();
    const inicio = new Date();
    inicio.setDate(hoje.getDate() - DIAS_ANALISE);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

    // Busca todos os pedidos paginando
    let pagina = 1;
    let totalPedidos = 0;
    const vendasPorSku = {}; // { sku: { nome, quantidade } }

    console.log("Iniciando sync de vendas...");

    while (true) {
      let data;
      try {
        data = await tinyGet(token, "pedidos", {
          pagina,
          dataInicial: fmt(inicio),
          dataFinal: fmt(hoje),
          situacao: "aprovado,faturado,entregue,pronto para retirada",
          limite: 100,
        });
      } catch(e) {
        console.error(`Erro buscando pedidos p${pagina}:`, e.response?.status);
        break;
      }

      const pedidos = data.itens || data.data || [];
      if (pedidos.length === 0) break;

      // Verifica se saiu do período — para quando data do pedido for anterior ao início
      const ultimoPedido = pedidos[pedidos.length - 1];
      const dataUltimo = ultimoPedido?.data || ultimoPedido?.dataPedido || ultimoPedido?.dataVenda || "";
      if (dataUltimo && dataUltimo < fmt(inicio)) {
        console.log(`Saiu do período em p${pagina}, parando.`);
        // Processa só os pedidos dentro do período
        pedidos.filter(p => {
          const dp = p.data || p.dataPedido || p.dataVenda || "";
          return !dp || dp >= fmt(inicio);
        });
        break;
      }

      // Debug: loga estrutura do primeiro pedido
      if (pagina === 1 && pedidos.length > 0) {
        console.log("DEBUG PEDIDO:", JSON.stringify(pedidos[0], null, 2).substring(0, 2000));
      }

      for (const pedido of pedidos) {
        // situacao pode ser string, numero ou objeto
        const situacaoRaw = pedido.situacao ?? pedido.status ?? "";
        const status = String(typeof situacaoRaw === "object" ? (situacaoRaw?.nome || situacaoRaw?.descricao || "") : situacaoRaw).toLowerCase();
        if (status.includes("cancelad")) continue;

        const itens = pedido.itens || pedido.items || pedido.produtos || pedido.itensPedido || [];
        for (const item of itens) {
          const sku = item.codigo || item.sku || item.codigoProduto || item.produto?.codigo || "";
          const nome = item.descricao || item.nome || item.nomeProduto || item.produto?.nome || "";
          const qtd = parseFloat(item.quantidade ?? item.qtd ?? item.quantidadeAtendida ?? 0);
          if (!sku || qtd <= 0) continue;

          if (!vendasPorSku[sku]) vendasPorSku[sku] = { nome, quantidade: 0 };
          vendasPorSku[sku].quantidade += qtd;
        }

        totalPedidos++;
      }

      console.log(`Página ${pagina}: ${pedidos.length} pedidos | Total: ${totalPedidos}`);
      if (pedidos.length < 100) break;
      pagina++;
    }

    // Salva no banco
    const skus = Object.entries(vendasPorSku);
    console.log(`Salvando ${skus.length} SKUs no banco...`);

    await pool.query("DELETE FROM vendas_sku");
    for (const [sku, dados] of skus) {
      await pool.query(
        `INSERT INTO vendas_sku (sku, nome, quantidade, atualizado)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (sku) DO UPDATE SET nome=$2, quantidade=$3, atualizado=NOW()`,
        [sku, dados.nome, Math.round(dados.quantidade)]
      );
    }

    await pool.query(
      "UPDATE sync_log SET terminou=NOW(), total_pedidos=$1, total_itens=$2, status=$3 WHERE id=$4",
      [totalPedidos, skus.length, "ok", logId]
    );

    console.log(`✅ Sync concluído: ${totalPedidos} pedidos, ${skus.length} SKUs`);
  } catch (e) {
    await pool.query(
      "UPDATE sync_log SET terminou=NOW(), status=$1, mensagem=$2 WHERE id=$3",
      ["erro", e.message, logId]
    );
    console.error("Erro sync:", e.message);
  }
}

// ── Marcas com paginação completa ─────────────────────────────────────────────
app.get("/marcas", async (req, res) => {
  const token = await garantirToken(req, res);
  if (!token) return;
  try {
    let pagina = 1, marcas = [];
    while (true) {
      const data = await tinyGet(token, "marcas", { pagina, limite: 100 });
      const itens = (data.itens || data.data || []).map(m => ({
        id: m.id,
        nome: m.nome || m.descricao || m.name || ""
      }));
      marcas = marcas.concat(itens);
      if (itens.length < 100) break;
      pagina++;
    }
    marcas.sort((a, b) => a.nome.localeCompare(b.nome));

    const itens = marcas.map(m =>
      `<a href="/sugestoes/${m.id}?nome=${encodeURIComponent(m.nome)}" class="marca-item">
        <span class="marca-nome">🏷️ ${m.nome}</span>
        <span class="badge">Ver sugestão →</span>
      </a>`
    ).join("");

    res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Fornecedores</title>${CSS}</head><body>
      <div class="card">
        <div class="row"><a href="/" class="voltar">←</a><h2>Selecionar Fornecedor</h2></div>
        <p class="sub">${marcas.length} marcas encontradas</p>
        <input type="text" id="busca" placeholder="🔍 Buscar marca..." oninput="filtrar(this.value)" autofocus/>
        <div class="lista" id="lista">${itens}</div>
        <a href="/" class="btn btn-gray btn-sm">← Início</a>
      </div>
      <script>
        const todos = Array.from(document.querySelectorAll('.marca-item'));
        function filtrar(v) {
          v = v.toLowerCase();
          todos.forEach(el => {
            el.style.display = el.querySelector('.marca-nome').textContent.toLowerCase().includes(v) ? '' : 'none';
          });
        }
      </script>
    </body></html>`);
  } catch (e) {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>${CSS}</head><body><div class="card"><div class="erro">Erro: ${e.message}</div><a href="/" class="btn btn-gray btn-sm" style="margin-top:12px">← Voltar</a></div></body></html>`);
  }
});

// ── Página de sugestões ───────────────────────────────────────────────────────
app.get("/sugestoes/:marcaId", async (req, res) => {
  const token = await garantirToken(req, res);
  if (!token) return;
  const { marcaId } = req.params;
  const nomeMarca = req.query.nome || marcaId;

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${nomeMarca}</title>${CSS}</head><body>
    <div class="card card-wide" id="conteudo">
      <div class="loader">
        <div class="spinner"></div>
        <p style="font-weight:600;font-size:16px;margin-bottom:8px;color:#1e293b">Calculando sugestões...</p>
        <p style="color:#64748b">Cruzando produtos de <strong>${nomeMarca}</strong> com vendas dos últimos ${DIAS_ANALISE} dias.</p>
      </div>
    </div>
    <script>
      fetch('/api/sugestoes/${marcaId}?nome=${encodeURIComponent(nomeMarca)}', { credentials: 'include' })
        .then(r => { if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(data => { if(!data.ok) throw new Error(data.erro||'Erro desconhecido'); renderizar(data); })
        .catch(e => {
          document.getElementById('conteudo').innerHTML =
            '<div class="row"><a href="/marcas" class="voltar">←</a><h2>Erro</h2></div>' +
            '<div class="erro">⚠️ ' + e.message + '</div>' +
            '<a href="/marcas" class="btn btn-gray btn-sm">← Voltar</a>';
        });

      function renderizar(data) {
        const prods = data.produtos || [];
        const total = data.totalUnidades || 0;
        let html = '<div class="row"><a href="/marcas" class="voltar">←</a><h2>🏷️ ' + data.marca + '</h2></div>';
        html += '<p class="sub">' + prods.length + ' produto(s) · cobertura ${DIAS_COBERTURA} dias · base ${DIAS_ANALISE} dias · sync: ' + data.ultimaSync + '</p>';

        if (data.semSync) {
          html += '<div class="warn">⚠️ Nenhuma sincronização encontrada. <a href="/sincronizar">Clique aqui para sincronizar</a> antes de ver as sugestões.</div>';
        }

        if (prods.length === 0) {
          html += '<div class="ok-grande"><div style="font-size:40px;margin-bottom:8px">✅</div><p style="font-weight:600;font-size:15px">Estoque em dia!<br>Nenhum produto de ' + data.marca + ' precisa de reposição.</p></div>';
        } else {
          // Ordena: sem venda primeiro, depois por urgência
          prods.sort((a,b) => {
            if(a.semVenda && !b.semVenda) return -1;
            if(!a.semVenda && b.semVenda) return 1;
            return b.urgencia - a.urgencia;
          });

          let linhas = prods.map((p,i) => {
            const bgRow = i%2===0?'#f9fafb':'#fff';
            const tagSugestao = p.semVenda
              ? '<span class="tag-warn">sem venda</span>'
              : '<span class="tag">' + p.sugestao + ' un</span>';
            const estoqueClass = p.estoqueAtual <= 0 ? 'vermelho' : p.estoqueAtual < 5 ? 'laranja' : 'verde';
            return '<tr style="background:'+bgRow+'">' +
              '<td><code style="font-size:11px;color:#64748b">'+(p.sku||'-')+'</code></td>' +
              '<td style="font-weight:500">' + p.nome + '</td>' +
              '<td class="tc '+estoqueClass+'">' + p.estoqueAtual + '</td>' +
              '<td class="tc">' + (p.vendidos60d||0) + '</td>' +
              '<td class="tc">' + p.mediaDiaria + '</td>' +
              '<td class="tc">' + p.necessario + '</td>' +
              '<td class="tc">' + tagSugestao + '</td>' +
              '</tr>';
          }).join('');

          html += '<div class="tbl-wrap"><table>' +
            '<thead><tr><th>SKU</th><th>Produto</th><th>Estoque</th><th>Vendidos 60d</th><th>Média/dia</th><th>Necessário</th><th>Sugestão</th></tr></thead>' +
            '<tbody>'+linhas+'</tbody>' +
            '<tfoot><tr style="background:#f1f5f9"><td colspan="6" style="text-align:right;font-weight:700;padding:9px 12px;font-size:13px">Total a pedir:</td>' +
            '<td class="tc"><span class="tag-total">'+total+' un</span></td></tr></tfoot>' +
            '</table></div>';
        }

        html += '<div class="rodape"><a href="/marcas" class="btn btn-gray btn-sm">← Outros fornecedores</a>';
        if(prods.length > 0) html += '<button class="btn btn-blue btn-sm" onclick="copiar()">📋 Copiar tabela</button>';
        html += '</div>';
        document.getElementById('conteudo').innerHTML = html;
        window._dados = data;
      }

      function copiar() {
        const prods = (window._dados||{}).produtos||[];
        const csv = ['SKU\\tProduto\\tEstoque\\tVendidos 60d\\tMédia/dia\\tNecessário\\tSugestão',
          ...prods.map(p=>[p.sku,p.nome,p.estoqueAtual,p.vendidos60d,p.mediaDiaria,p.necessario,p.semVenda?'sem venda':p.sugestao].join('\\t'))
        ].join('\\n');
        navigator.clipboard.writeText(csv).then(()=>alert('Tabela copiada!'));
      }
    </script>
  </body></html>`);
});

// ── API: calcula sugestões cruzando banco + Tiny ──────────────────────────────
app.get("/api/sugestoes/:marcaId", async (req, res) => {
  try {
    if (!req.session.access_token) return res.status(401).json({ ok: false, erro: "Não autenticado." });
    const token = req.session.access_token;
    const { marcaId } = req.params;
    const nomeMarca = req.query.nome || marcaId;

    // Verifica se tem sync
    const syncRes = await pool.query("SELECT terminou FROM sync_log WHERE status='ok' ORDER BY id DESC LIMIT 1");
    const ultimaSync = syncRes.rows[0]?.terminou
      ? new Date(syncRes.rows[0].terminou).toLocaleString("pt-BR")
      : null;

    // Busca produtos da marca no Tiny
    let pagina = 1, produtos = [];
    while (true) {
      const data = await tinyGet(token, "produtos", { pagina, situacao: "A", idMarca: marcaId, limite: 100 });
      const itens = data.itens || data.data || [];
      produtos = produtos.concat(itens);
      if (itens.length < 100) break;
      pagina++;
    }

    // Busca vendas do banco para os SKUs desses produtos
    const skusProdutos = produtos.map(p => p.codigo || p.sku || "").filter(Boolean);
    let vendasMap = {};

    if (skusProdutos.length > 0) {
      const placeholders = skusProdutos.map((_, i) => `$${i+1}`).join(",");
      const vendasRes = await pool.query(
        `SELECT sku, quantidade FROM vendas_sku WHERE sku IN (${placeholders})`,
        skusProdutos
      );
      for (const row of vendasRes.rows) {
        vendasMap[row.sku] = row.quantidade;
      }
    }

    // Calcula sugestões
    const sugestoes = produtos.map(prod => {
      const sku = prod.codigo || prod.sku || "";
      const estoqueAtual = parseFloat(prod.saldo ?? prod.estoque ?? prod.saldoFisico ?? 0);
      const vendidos60d = vendasMap[sku] || 0;
      const semVenda = vendidos60d === 0;
      const mediaDiaria = vendidos60d / DIAS_ANALISE;
      const necessario = Math.ceil(mediaDiaria * DIAS_COBERTURA);
      const sugestao = Math.max(0, Math.ceil(necessario - estoqueAtual));
      const precisaComprar = semVenda ? estoqueAtual <= 0 : sugestao > 0;
      const urgencia = semVenda ? (estoqueAtual <= 0 ? 999 : 0) : sugestao;

      return {
        id: prod.id,
        nome: prod.nome,
        sku,
        estoqueAtual,
        vendidos60d,
        semVenda,
        mediaDiaria: parseFloat(mediaDiaria.toFixed(2)),
        necessario,
        sugestao,
        precisaComprar,
        urgencia,
      };
    }).filter(p => p.precisaComprar);

    res.json({
      ok: true,
      marca: nomeMarca,
      marcaId,
      ultimaSync: ultimaSync || "nunca",
      semSync: !ultimaSync,
      diasAnalise: DIAS_ANALISE,
      diasCobertura: DIAS_COBERTURA,
      totalProdutos: produtos.length,
      totalParaRepor: sugestoes.length,
      totalUnidades: sugestoes.filter(p => !p.semVenda).reduce((s,p) => s + p.sugestao, 0),
      produtos: sugestoes,
    });
  } catch (e) {
    console.error("Erro API sugestões:", e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── Cron: sincroniza toda madrugada às 02:00 ──────────────────────────────────
cron.schedule("0 2 * * *", async () => {
  console.log("🕐 Cron: iniciando sync automático...");
  try {
    const token = await obterTokenSalvo();
    if (!token) { console.log("Cron: sem token salvo, pulando sync"); return; }
    await sincronizarVendas(token);
  } catch(e) {
    console.error("Cron erro:", e.message);
  }
}, { timezone: "America/Sao_Paulo" });

app.get("/logout", (req, res) => { req.session.destroy(); res.redirect("/"); });

iniciarBanco().then(() => {
  app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
}).catch(e => {
  console.error("Erro ao iniciar banco:", e.message);
  process.exit(1);
});
