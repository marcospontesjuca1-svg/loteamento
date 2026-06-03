require('dotenv').config();
const sql    = require('mssql');
const admin  = require('firebase-admin');
const cron   = require('node-cron');
const https  = require('https');

// ── Firebase Admin ────────────────────────────────────────────────────────────
const serviceAccount = require('./serviceaccount.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
db.settings({ databaseId: 'sws-import' });

// ── SQL Server ────────────────────────────────────────────────────────────────
const sqlConfig = {
  user:     process.env.DB_USER     || 'sa',
  password: process.env.DB_PASSWORD || '',
  server:   process.env.DB_SERVER   || '10.0.0.10',
  options: {
    instanceName:        process.env.DB_INSTANCE || 'SERV2012R2\\SWS',
    encrypt:             false,
    trustServerCertificate: true,
    enableArithAbort:    true,
  }
};

const BDWIND  = process.env.DB_BDWIND  || 'BDWind';
const SCRWIND = process.env.DB_SCRWIND || 'SCRWind';
const DEBUG   = process.env.DEBUG === 'true';

// ── GitHub (export JSON estático) ────────────────────────────────────────────
const GH_TOKEN = process.env.GH_TOKEN  || '';
const GH_OWNER = process.env.GH_OWNER  || 'marcospontesjuca1-svg';
const GH_REPO  = process.env.GH_REPO   || 'loteamento';
const GH_PATH  = 'data/contas-receber.json';

// ── Definição das coleções ────────────────────────────────────────────────────
const COLECOES = [
  {
    collection: 'posicao_contas_receber',
    database:   SCRWIND,
    keyField:   'CODTIT',
    exportJson: true,   // exportado para GitHub Pages como contas-receber.json
    sql: `
      SELECT
        CODTIT,
        CODCLI,
        NOMECLI,
        NUMDOC,
        PARCELA,
        CONVERT(VARCHAR(10), DTEMIS, 120)  AS DTEMIS,
        CONVERT(VARCHAR(10), DTVENC, 120)  AS DTVENC,
        VALOR,
        SALDO,
        CASE
          WHEN SALDO <= 0            THEN 'quitado'
          WHEN DTVENC < GETDATE()    THEN 'vencido'
          ELSE                            'aberto'
        END AS STATUS
      FROM ${SCRWIND}.dbo.CR_POSICAO_TITULOS   -- ← ajuste o nome da tabela/view
      WHERE SALDO > 0 OR DTVENC >= DATEADD(MONTH,-3,GETDATE())
    `
  },
  {
    // ── QUITAÇÕES / RECEBIMENTOS ──────────────────────────────────────────────
    // Registros de pagamento efetivo. Ajuste o nome da tabela conforme o SWS:
    //   Opções comuns: CR_RECEBIMENTOS, CR_QUITACOES, CR_LIQUIDACOES,
    //                  CR_BAIXAS, VPR_RECEBIMENTOS
    collection: 'quitacoes_contas_receber',
    database:   SCRWIND,
    keyField:   'CODRECEB',          // ajuste o campo chave
    exportJson: true,                // exportado para GitHub Pages como quitacoes.json
    exportFile: 'data/quitacoes.json',
    sql: `
      SELECT
        CODRECEB,                    -- ← chave única do recebimento
        CODTIT,                      -- ← código do título quitado
        CODCLI,
        NOMECLI,
        NUMDOC,
        PARCELA,
        CONVERT(VARCHAR(10), DTQUIT,  120) AS DTQUIT,   -- data de quitação
        CONVERT(VARCHAR(10), DTVENC,  120) AS DTVENC,   -- vencimento original
        VALORQUIT,                   -- valor efetivamente recebido
        VALOR,                       -- valor original do título
        HISTORICO
      FROM ${SCRWIND}.dbo.CR_RECEBIMENTOS   -- ← ajuste para a tabela real do SWS
      WHERE DTQUIT >= DATEADD(YEAR,-2,GETDATE())
      ORDER BY DTQUIT DESC
    `
  },
  {
    collection: 'clientes',
    database:   BDWIND,
    keyField:   'CODCLI',
    sql: `
      SELECT
        CODCLI,
        NOMECLI,
        CGCCPF       AS CPF_CNPJ,
        FONE1        AS TELEFONE,
        EMAIL,
        ENDERECO,
        BAIRRO,
        CIDADE,
        UF,
        CEP
      FROM ${BDWIND}.dbo.CLIENTES   -- ← ajuste o nome da tabela/view
    `
  },
  {
    collection: 'lancamentos_contas_receber',
    database:   SCRWIND,
    keyField:   'CODLANC',
    sql: `
      SELECT
        CODLANC,
        CODTIT,
        CODCLI,
        NOMECLI,
        CONVERT(VARCHAR(10), DTLANC, 120) AS DTLANC,
        VALOR,
        HISTORICO,
        TIPO
      FROM ${SCRWIND}.dbo.CR_LANCAMENTOS   -- ← ajuste o nome da tabela/view
      WHERE DTLANC >= DATEADD(YEAR,-2,GETDATE())
    `
  },
  {
    collection: 'conta_receber_ocorrencias',
    database:   SCRWIND,
    keyField:   'CODOCOR',
    sql: `
      SELECT
        CODOCOR,
        CODTIT,
        CODCLI,
        CONVERT(VARCHAR(10), DTOCOR, 120) AS DTOCOR,
        DESCRICAO,
        TIPO
      FROM ${SCRWIND}.dbo.CR_OCORRENCIAS   -- ← ajuste o nome da tabela/view
      WHERE DTOCOR >= DATEADD(MONTH,-6,GETDATE())
    `
  },
  {
    collection: 'posicao_contas_pagar',
    database:   SCRWIND,
    keyField:   'CODTIT',
    sql: `
      SELECT
        CODTIT,
        CODFORN,
        NOMEFORN,
        NUMDOC,
        PARCELA,
        CONVERT(VARCHAR(10), DTEMIS, 120) AS DTEMIS,
        CONVERT(VARCHAR(10), DTVENC, 120) AS DTVENC,
        VALOR,
        SALDO,
        CASE
          WHEN SALDO <= 0         THEN 'quitado'
          WHEN DTVENC < GETDATE() THEN 'vencido'
          ELSE                         'aberto'
        END AS STATUS
      FROM ${SCRWIND}.dbo.CP_POSICAO_TITULOS   -- ← ajuste o nome da tabela/view
      WHERE SALDO > 0 OR DTVENC >= DATEADD(MONTH,-3,GETDATE())
    `
  },
  {
    collection: 'fluxo_de_caixa',
    database:   SCRWIND,
    keyField:   'CODLANC',
    sql: `
      SELECT
        CODLANC,
        CONVERT(VARCHAR(10), DTLANC, 120) AS DTLANC,
        DESCRICAO,
        VALOR,
        TIPO,
        CONTA
      FROM ${SCRWIND}.dbo.FLUXO_CAIXA   -- ← ajuste o nome da tabela/view
      WHERE DTLANC >= DATEADD(MONTH,-6,GETDATE())
    `
  },
  {
    collection: 'lancamentos_custos',
    database:   SCRWIND,
    keyField:   'CODLANC',
    sql: `
      SELECT
        CODLANC,
        CONVERT(VARCHAR(10), DTLANC, 120) AS DTLANC,
        CENTROCUSTO,
        DESCRICAO,
        VALOR,
        TIPO
      FROM ${SCRWIND}.dbo.LANCAMENTOS_CUSTOS   -- ← ajuste o nome da tabela/view
      WHERE DTLANC >= DATEADD(MONTH,-6,GETDATE())
    `
  }
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg)  { console.log(`[${new Date().toLocaleString('pt-BR')}] ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toLocaleString('pt-BR')}] ⚠ ${msg}`); }

// Grava array de registros em coleção Firestore usando batched writes
async function gravaColecao(colName, registros, keyField) {
  if (!registros.length) { log(`  ${colName}: 0 registros, nada a gravar.`); return; }

  // Grava no sub-caminho sql_exports/<colName>/rows para manter compatibilidade
  const parentRef = db.collection('sql_exports').doc(colName);
  await parentRef.set({
    collection_name: colName,
    database_id:     'sws-import',
    row_count:       registros.length,
    synced_at_utc:   new Date().toISOString()
  });

  const colRef  = parentRef.collection('rows');
  const BATCH   = 400;
  let gravados  = 0;

  for (let i = 0; i < registros.length; i += BATCH) {
    const lote = registros.slice(i, i + BATCH);
    const batch = db.batch();
    for (const reg of lote) {
      const id  = String(reg[keyField] ?? `doc_${i}_${Math.random()}`);
      const doc = colRef.doc(id);
      const data = {};
      for (const [k, v] of Object.entries(reg)) {
        data[k] = v === null || v === undefined ? '' : v;
      }
      data._syncedAt = new Date().toISOString();
      batch.set(doc, data);
    }
    await batch.commit();
    gravados += lote.length;
  }
  log(`  ✓ ${colName}: ${gravados} registros gravados no Firestore`);
}

// Faz PUT do arquivo JSON no GitHub via REST API
function githubPutFile(path, content, message) {
  return new Promise(async (resolve, reject) => {
    if (!GH_TOKEN) { warn('GH_TOKEN não configurado — pulando export JSON'); resolve(); return; }

    const body64 = Buffer.from(content, 'utf8').toString('base64');

    // Busca SHA atual do arquivo (necessário para update)
    let sha = '';
    try {
      const existing = await githubGet(`/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`);
      sha = existing.sha || '';
    } catch (_) { /* arquivo não existe ainda, sha vazio = criação */ }

    const payload = JSON.stringify({ message, content: body64, ...(sha ? { sha } : {}) });
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`,
      method:   'PUT',
      headers: {
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Content-Type':  'application/json',
        'User-Agent':    'sws-sync-script',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method:   'GET',
      headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'User-Agent': 'sws-sync-script' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`GitHub API ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Exporta dados para um JSON estático no GitHub Pages
async function exportarJsonGitHub(col, registros) {
  if (!GH_TOKEN) {
    warn(`Export JSON desativado (GH_TOKEN ausente). Configure em .env para ativar.`);
    return;
  }
  const filePath = col.exportFile || GH_PATH;
  try {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      count:      registros.length,
      rows:       registros
    });
    const msg = `data: atualiza ${col.collection} (${registros.length} registros) [skip ci]`;
    await githubPutFile(filePath, payload, msg);
    log(`  ✓ JSON exportado → https://${GH_OWNER}.github.io/${GH_REPO}/${filePath}`);
  } catch (err) {
    warn(`Falha no export JSON: ${err.message}`);
  }
}

// ── Sincronização principal ───────────────────────────────────────────────────
async function sincronizar() {
  log('━━━ Iniciando sincronização SWS → Firestore ━━━');
  let pool;
  try {
    pool = await sql.connect(sqlConfig);
    log('✓ Conectado ao SQL Server');

    for (const col of COLECOES) {
      try {
        if (DEBUG) log(`  SQL: ${col.sql.trim().slice(0, 120)}...`);
        const result = await pool.request().query(col.sql);
        const rows = result.recordset;
        log(`  ${col.collection}: ${rows.length} linhas do SQL Server`);
        await gravaColecao(col.collection, rows, col.keyField);

        // Exporta JSON estático para GitHub Pages (apenas coleção marcada)
        if (col.exportJson) {
          await exportarJsonGitHub(col, rows);
        }
      } catch (err) {
        warn(`Erro em [${col.collection}]: ${err.message}`);
      }
    }

    await db.collection('_meta').doc('sync').set({
      ultimaSync: new Date().toISOString(),
      status:     'ok',
      colecoes:   COLECOES.map(c => c.collection)
    });

    log('━━━ Sincronização concluída ━━━\n');
  } catch (err) {
    warn(`Falha na conexão SQL Server: ${err.message}`);
  } finally {
    if (pool) await pool.close();
  }
}

// ── Inicialização ─────────────────────────────────────────────────────────────
const runOnce = process.argv.includes('--once');

if (runOnce) {
  sincronizar().then(() => process.exit(0)).catch(e => { warn(e); process.exit(1); });
} else {
  sincronizar();
  const schedule = process.env.CRON_SCHEDULE || '0 * * * *';
  log(`Agendamento ativo: "${schedule}"  (próxima execução automática)`);
  cron.schedule(schedule, sincronizar);
}
