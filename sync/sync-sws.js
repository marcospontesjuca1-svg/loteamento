require('dotenv').config();
const sql    = require('mssql');
const admin  = require('firebase-admin');
const cron   = require('node-cron');
const path   = require('path');

// ── Firebase Admin ────────────────────────────────────────────────────────────
const serviceAccount = require('./serviceaccount.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
db.settings({ databaseId: 'swsdb' });

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

// ── Definição das coleções ────────────────────────────────────────────────────
// Cada entrada define:
//   collection : nome da coleção no Firestore
//   db         : banco SQL Server a usar
//   sql        : query SQL  (substitua pelas views/tabelas reais do SWS)
//   keyField   : campo que vira ID do documento no Firestore
const COLECOES = [
  {
    collection: 'posicao_contas_receber',
    database:   SCRWIND,
    keyField:   'CODTIT',
    // ── AJUSTE A QUERY ABAIXO com as tabelas reais do SWS ──────────────────
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

// Grava um array de registros em uma coleção Firestore usando batched writes
async function gravaColecao(colName, registros, keyField) {
  if (!registros.length) { log(`  ${colName}: 0 registros, nada a gravar.`); return; }

  const colRef = db.collection(colName);
  const BATCH_SIZE = 400; // Firestore limita 500 operações por batch
  let gravados = 0;

  for (let i = 0; i < registros.length; i += BATCH_SIZE) {
    const lote = registros.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const reg of lote) {
      const id  = String(reg[keyField] ?? `doc_${i}_${Math.random()}`);
      const doc = colRef.doc(id);
      // Converte campos null em string vazia e números em tipo correto
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
  log(`  ✓ ${colName}: ${gravados} registros gravados`);
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
      } catch (err) {
        warn(`Erro em [${col.collection}]: ${err.message}`);
      }
    }

    // Atualiza timestamp de última sincronização
    await db.collection('_meta').doc('sync').set({
      ultimaSync:   new Date().toISOString(),
      status:       'ok',
      colecoes:     COLECOES.map(c => c.collection)
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
  // node sync-sws.js --once  →  executa uma vez e encerra
  sincronizar().then(() => process.exit(0)).catch(e => { warn(e); process.exit(1); });
} else {
  // Executa imediatamente ao iniciar, depois segue o agendamento
  sincronizar();
  const schedule = process.env.CRON_SCHEDULE || '0 * * * *';
  log(`Agendamento ativo: "${schedule}"  (próxima execução automática)`);
  cron.schedule(schedule, sincronizar);
}
