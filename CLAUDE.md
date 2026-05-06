# CLAUDE.md — Portal do Horizonte · Sistema Comercial

## Visão Geral

SPA (Single-Page Application) de gestão comercial de loteamento, construída em **HTML/CSS/JS puro**, sem framework ou bundler. Todo o código reside em um único arquivo: `index.html` (~480 KB, ~1161 linhas).

**Repositório:** `marcospontesjuca1-svg/loteamento`  
**Deploy:** GitHub Pages (branch `main` → raiz do repositório)

---

## Stack Técnica

| Camada | Tecnologia |
|--------|-----------|
| Estrutura | HTML5 + CSS3 + JS ES2020 (inline, sem módulos) |
| Persistência | Firebase Firestore v9 (compat SDK via CDN) |
| Fontes | Google Fonts — DM Sans + DM Mono |
| CEP | API ViaCEP (consulta automática no cadastro) |
| Gráficos | Canvas API nativo (sem biblioteca externa) |
| Deploy | GitHub Pages |

**Dependências CDN (sem `package.json`):**
- `https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js`
- `https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js`

---

## Estrutura do Arquivo `index.html`

O arquivo segue esta ordem:

1. `<head>` — meta tags, fontes, bloco `<style>` com todo o CSS (variáveis CSS, componentes)
2. `<body>` — sidebar de navegação + páginas (`.pg`) ocultas por padrão
3. `<script>` — configuração Firebase, estado global, funções de renderização, event listeners

### Páginas / Módulos

| ID da página | Módulo |
|---|---|
| `dashboard` | KPIs, gráfico de receita, pipeline Kanban resumido |
| `lotes` | Mapa de lotes com status (Disponível / Reservado / Vendido) |
| `clientes` | Cadastro de compradores com busca por CPF/nome |
| `vendas` | Registro e acompanhamento de vendas |
| `reservas` | Sistema de reservas com prazo de expiração |
| `contratos` | Geração e impressão de contratos (print CSS incluído) |
| `financeiro` | Receita, inadimplência, parcelas |
| `kanban` | Pipeline comercial em colunas drag-and-drop |
| `precificacao` | Tabela de preços dinâmica por lote/bloco |
| `relatorios` | Exportação de dados em PDF/print |

### Navegação

A função `showPage(id)` troca a classe `.active` entre as divs `.pg` e atualiza o item ativo na sidebar (`.ni`).

---

## Firebase / Firestore

**Projeto:** `loteamento-21e59`

```js
const fbCfg = {
  apiKey: "AIzaSyBOyLV1ww1MiYBpcNtvmuz2rrSWNAsBUVU",
  authDomain: "loteamento-21e59.firebaseapp.com",
  projectId: "loteamento-21e59",
  storageBucket: "loteamento-21e59.firebasestorage.app",
  messagingSenderId: "353639967679",
  appId: "1:353639967679:web:d093e12e171fc7ee9a0f0a"
};
```

**Coleção principal:** `dados`  
O documento raiz armazena sub-coleções e arrays (lotes, clientes, vendas, etc.).

**Padrão de sincronização:**
- Ao iniciar: `db.collection('dados').onSnapshot(...)` — listener em tempo real
- Para salvar: `db.collection('dados').doc(id).set(...)` ou `.update(...)`
- Estado local espelha o Firestore em memória (`window.state` ou equivalente)

---

## Convenções de Código

- **CSS:** variáveis em `:root` (`--green`, `--red`, `--surface`, etc.). Classes curtas (`.ni`, `.pg`, `.ch`, `.kpi`). Sem BEM formal.
- **JS:** funções globais no escopo `window`. Estado compartilhado via variáveis globais (`let lotes`, `let clientes`, etc.).
- **HTML:** todo inline — sem arquivos externos, sem imports.
- **Impressão:** CSS `@media print` e `@page` embutidos para contratos A4.
- **Idioma:** Português brasileiro em toda a UI.

---

## Como Editar

### Adicionar uma nova página

1. Criar `<div id="nova-pagina" class="pg">` no body
2. Adicionar item na sidebar: `<button class="ni" onclick="showPage('nova-pagina')">`
3. Implementar a lógica JS na seção de scripts

### Alterar cores/tema

Editar as variáveis CSS em `:root` no início do `<style>`:

```css
:root {
  --green: #1a7a50;
  --blue:  #1a4fa0;
  --amber: #b05a10;
  --red:   #9a1f1f;
  /* ... */
}
```

### Adicionar campo ao Firestore

1. Atualizar o objeto salvo na função de persistência correspondente
2. Atualizar a função de renderização que lê esse objeto
3. Não há schema rígido — Firestore aceita campos novos automaticamente

---

## Deploy

O GitHub Pages serve `index.html` diretamente da branch `main`.

**Fluxo para publicar alterações:**

```
editar index.html
  → commit na branch de feature
  → Pull Request para main
  → Merge
  → GitHub Pages atualiza automaticamente (~1 min)
```

O deploy pode ser acompanhado em: **GitHub → Actions** ou **Deployments → github-pages**.

---

## Documentos de Referência

- `CONTRATO PADRÃO.pdf` — modelo jurídico do contrato de compra e venda
- `MEMORIAL DESCRITIVO - LOTEAMENTO PORTAL DO HORIZONTE.pdf` — especificações técnicas do loteamento
