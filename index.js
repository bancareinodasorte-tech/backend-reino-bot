import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  initAuthCreds,
  BufferJSON,
  proto
} from '@whiskeysockets/baileys';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const CONFIG = {
  sistema: 'Reino Zap PRO',
  versao: '17.0.0',
  bilheteValor: 2,
  pixChave: '88994943632',
  pixNome: 'G. DA SILVA',
  intervaloPadrao: 8000,
  limitePadrao: 20,
  authTabela: 'zap_auth'
};

let sock = null;
let qrAtual = '';
let qrDataUrl = '';
let conectado = false;
let iniciando = false;
let numeroConectado = '';
let ultimaMensagem = null;
let campanhaRodando = false;
let campanhaProgresso = { id: null, nome: '', total: 0, enviados: 0, erros: 0, status: 'parado', inicio: null, fim: null };
let campanhaHistorico = [];
let campanhaAtual = null;
let agendamentos = [];
const modelosCampanha = [
  { id: 'modelo_01', nome: 'Oferta padrão bilhete R$2', texto: '🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.' },
  { id: 'modelo_02', nome: 'Chamada curta', texto: '🍀 Quer participar do Reino da Sorte hoje?\n\nBilhete R$ 2,00. Responda só com a quantidade.' },
  { id: 'modelo_03', nome: 'Giros extras', texto: '💥 Hoje tem oportunidade no Reino da Sorte!\n\nBilhete R$ 2,00. Quer quantos bilhetes?' }
];

const memoria = { contatos: new Map(), mensagens: [] };
const mensagensProcessadas = new Set();
const travaResposta = new Map();

function limparTelefone(telefone = '') {
  return String(telefone).replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
}
function jidDoNumero(telefone = '') { return `${limparTelefone(telefone)}@s.whatsapp.net`; }
function moeda(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function textoNormalizado(v = '') { return String(v || '').trim().toLowerCase(); }
function detectarInteresse(texto = '') {
  const t = textoNormalizado(texto); if (!t) return false;
  const palavras = ['quero','comprar','participar','bilhete','bilhetes','pix','valor','manda','sim','vou querer','tenho interesse','quanto','pode ser','ok','oi','olá'];
  return palavras.some(p => t.includes(p));
}
function detectarQuantidade(texto = '') {
  const m = textoNormalizado(texto).match(/\b(\d{1,4})\b/); if (!m) return null;
  const n = Number(m[1]); return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
}
function detectarComprovante(msg, texto = '', statusAtual = '') {
  const m = msg?.message || {};
  const t = textoNormalizado(texto);
  const palavrasPg = ['paguei','pago','comprovante','enviei','transferi','pix feito','pagamento feito'];
  if (palavrasPg.some(p => t.includes(p))) return true;
  // PDF/documento enviado pelo cliente normalmente é comprovante.
  if (m.documentMessage && !msg?.key?.fromMe) return true;
  // Imagem só vira comprovante se o cliente já estava na etapa de pagamento,
  // evitando que qualquer print/foto solta bagunce o fluxo.
  if (m.imageMessage && ['aguardando_pagamento','interessado'].includes(statusAtual)) return true;
  return false;
}
function detectarDadosCliente(texto = '') {
  const raw = String(texto || '').trim();
  if (!raw) return null;
  const tel = raw.match(/(?:\+?55)?\s*\(?0?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/);
  const linhas = raw.split(/\n|,/).map(l => l.trim()).filter(Boolean);
  const nomeLinha = linhas.find(l => /[a-záàâãéèêíïóôõöúçñ]{3,}/i.test(l) && !/telefone|fone|whats|zap|\d{5}/i.test(l));
  if (tel && nomeLinha) return { nome: nomeLinha.replace(/nome[:\-]*/i,'').trim(), telefoneInformado: limparTelefone(tel[0]) };
  return null;
}
function detectarPdfDoAtendente(msg) { return Boolean(msg?.key?.fromMe && msg?.message?.documentMessage); }
function extrairTextoMensagem(message = {}) {
  return message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.documentMessage?.caption || message.videoMessage?.caption || '';
}
function respostaQuantidade(qtd) {
  const total = qtd * CONFIG.bilheteValor;
  return `Perfeito! 🎟️\n\nVocê escolheu: ${qtd} bilhete${qtd > 1 ? 's' : ''}\n\n💰 Total: ${moeda(total)}\n\n📲 Pagamento via Pix:\nChave: ${CONFIG.pixChave}\nNome: ${CONFIG.pixNome}\n\n⚠️ Envie o comprovante aqui para confirmar seu pedido.`;
}
function perguntaQuantidade() { return `Perfeito! 🎟️\n\nQuantos bilhetes você deseja comprar?\nDigite apenas o número.\n\nExemplo: 1, 2, 5, 10...`; }
function respostaComprovante() { return `Recebido! ✅\n\n- Preencha os dados\nNOME:\nTELEFONE:\n\n⚠️ Aguarde o comprovante dos seus bilhetes`; }
function agradecimentoFinal() { return `REINO DA SORTE AGRADECE SUA COMPRA\n\n🍀 Boa Sorte 🍀`; }

async function supabase(method, path, body = null, extraHeaders = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=merge-duplicates,return=representation', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) { console.log('Supabase erro:', method, path, await r.text()); return null; }
  if (r.status === 204) return null;
  try { return await r.json(); } catch { return null; }
}

async function authRead(id) {
  const data = await supabase('GET', `${CONFIG.authTabela}?id=eq.${encodeURIComponent(id)}&select=value&limit=1`);
  const raw = Array.isArray(data) && data[0]?.value ? data[0].value : null;
  return raw ? JSON.parse(JSON.stringify(raw), BufferJSON.reviver) : null;
}
async function authWrite(id, value) {
  const safe = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  await supabase('POST', `${CONFIG.authTabela}?on_conflict=id`, { id, value: safe, updated_at: new Date().toISOString() });
}
async function authRemove(id) { await supabase('DELETE', `${CONFIG.authTabela}?id=eq.${encodeURIComponent(id)}`); }

async function useSupabaseAuthState() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return useMultiFileAuthState('./auth');
  const creds = (await authRead('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await authRead(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? authWrite(key, value) : authRemove(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => authWrite('creds', creds)
  };
}

async function salvarContato({ telefone, nome = '', status = 'novo', ultima_mensagem = '', interessado = false, quantidade = null, comprovante = false }) {
  const tel = limparTelefone(telefone); if (!tel) return;
  const atual = memoria.contatos.get(tel) || {};
  const contato = { telefone: tel, nome: nome || atual.nome || '', status: status || atual.status || 'novo', ultima_mensagem: ultima_mensagem || atual.ultima_mensagem || '', interessado: Boolean(interessado || atual.interessado), quantidade: quantidade || atual.quantidade || null, comprovante: Boolean(comprovante || atual.comprovante) };
  memoria.contatos.set(tel, contato);
  await supabase('POST', 'contatos?on_conflict=telefone', contato);
}
async function salvarResposta({ telefone, mensagem, interessado = false }) {
  const tel = limparTelefone(telefone);
  memoria.mensagens.unshift({ telefone: tel, mensagem, interessado, criado_em: new Date().toISOString() });
  memoria.mensagens = memoria.mensagens.slice(0, 200);
  await supabase('POST', 'respostas', { telefone: tel, mensagem, interessado });
  if (interessado) await supabase('POST', 'interessados', { telefone: tel, origem: 'whatsapp' });
}
async function listarContatos() {
  const data = await supabase('GET', 'contatos?select=*&order=id.desc');
  if (Array.isArray(data)) return data;
  return Array.from(memoria.contatos.values()).reverse();
}
async function enviarTextoDestino(destino, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  const jidFinal = String(destino || '').includes('@') ? destino : jidDoNumero(destino);
  return await sock.sendMessage(jidFinal, { text: texto });
}
async function enviarTexto(telefone, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  const jid = jidDoNumero(telefone);
  const existe = await sock.onWhatsApp(jid).catch(() => null);
  const jidFinal = existe?.[0]?.jid || jid;
  const resp = await sock.sendMessage(jidFinal, { text: texto });
  return { jid: jidFinal, resposta: resp };
}

async function iniciarWhatsApp() {
  if (iniciando) return;
  iniciando = true;
  try {
    const { state, saveCreds } = await useSupabaseAuthState();
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: ['Reino Zap', 'Chrome', CONFIG.versao] });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrAtual = qr; qrDataUrl = await QRCode.toDataURL(qr); conectado = false; console.log('QR gerado'); }
      if (connection === 'open') { conectado = true; qrAtual = ''; qrDataUrl = ''; numeroConectado = sock.user?.id || ''; console.log('WhatsApp conectado:', numeroConectado); }
      if (connection === 'close') {
        conectado = false;
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log('WhatsApp desconectado:', reason);
        if (reason !== DisconnectReason.loggedOut) setTimeout(() => { iniciando = false; iniciarWhatsApp(); }, 4000);
      }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages || []) {
        try {
          if (!msg.message) continue;
          const idMsg = msg.key?.id || `${Date.now()}-${Math.random()}`;
          if (mensagensProcessadas.has(idMsg)) continue;
          mensagensProcessadas.add(idMsg);
          if (mensagensProcessadas.size > 1000) mensagensProcessadas.clear();

          const fromMe = Boolean(msg.key?.fromMe);
          const jid = msg.key?.remoteJid || '';
          const telefone = limparTelefone(jid);
          const texto = extrairTextoMensagem(msg.message);
          const contatoAtual = memoria.contatos.get(telefone) || {};
          const dadosCliente = detectarDadosCliente(texto);
          const comprovante = detectarComprovante(msg, texto, contatoAtual.status || '');
          const qtd = detectarQuantidade(texto);
          const interessado = detectarInteresse(texto) || Boolean(qtd);

          ultimaMensagem = { de: jid, telefone, mensagem: texto || '[mídia]', tipo: comprovante ? 'comprovante/midia' : 'texto', interessado, quantidade: qtd, comprovante, data: new Date().toISOString() };

          if (fromMe) {
            if (detectarPdfDoAtendente(msg)) { await enviarTextoDestino(jid, agradecimentoFinal()); await salvarContato({ telefone, status: 'finalizado', ultima_mensagem: '[PDF enviado pelo atendente]' }); }
            continue;
          }
          await salvarResposta({ telefone, mensagem: texto || '[mídia/comprovante]', interessado });

          if (dadosCliente && contatoAtual.status === 'aguardando_dados') {
            await salvarContato({ telefone, nome: dadosCliente.nome, status: 'aguardando_finalizacao', ultima_mensagem: texto, interessado: true, comprovante: true });
            continue;
          }

          const agora = Date.now();
          const travaKey = `${jid}:${qtd || textoNormalizado(texto) || 'midia'}`;
          if (travaResposta.has(travaKey) && agora - travaResposta.get(travaKey) < 90000) continue;
          travaResposta.set(travaKey, agora);

          if (comprovante) { await salvarContato({ telefone, status: 'aguardando_dados', ultima_mensagem: texto || '[comprovante]', interessado: true, comprovante: true }); await enviarTextoDestino(jid, respostaComprovante()); continue; }
          if (qtd) { await salvarContato({ telefone, status: 'aguardando_pagamento', ultima_mensagem: texto, interessado: true, quantidade: qtd }); await enviarTextoDestino(jid, respostaQuantidade(qtd)); continue; }
          if (interessado) { await salvarContato({ telefone, status: 'interessado', ultima_mensagem: texto, interessado: true }); await enviarTextoDestino(jid, perguntaQuantidade()); }
          else { await salvarContato({ telefone, status: 'respondeu', ultima_mensagem: texto, interessado: false }); }
        } catch (e) { console.log('Erro processando mensagem:', e.message); }
      }
    });
  } catch (e) { console.log('Erro ao iniciar WhatsApp:', e.message); }
  finally { iniciando = false; }
}
iniciarWhatsApp();


app.get('/status', (req, res) => res.json({ online: true, sistema: CONFIG.sistema, versao: CONFIG.versao, conectado, numeroConectado, temQr: Boolean(qrDataUrl), ultimaMensagemRecebida: ultimaMensagem, campanhaProgresso, campanhaHistorico: campanhaHistorico.slice(0, 6), agendamentos, auth: SUPABASE_URL ? 'supabase' : 'local' }));
app.get('/qr', (req, res) => res.json({ conectado, numeroConectado, qr: qrDataUrl }));
app.get('/api/contatos', async (req, res) => res.json({ sucesso: true, contatos: await listarContatos() }));
app.post('/api/contatos', async (req, res) => { await salvarContato({ telefone: req.body.telefone, nome: req.body.nome, status: 'novo' }); res.json({ sucesso: true }); });
app.post('/api/enviar', async (req, res) => { try { const envio = await enviarTexto(req.body.telefone, req.body.mensagem); res.json({ sucesso: true, envio }); } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); } });
app.get('/api/modelos', (req, res) => res.json({ sucesso: true, modelos: modelosCampanha }));
app.post('/api/modelos', (req, res) => {
  const nome = String(req.body.nome || '').trim() || `Campanha ${modelosCampanha.length + 1}`;
  const texto = String(req.body.texto || '').trim();
  if (!texto) return res.status(400).json({ sucesso: false, erro: 'Texto vazio' });
  const modelo = { id: `modelo_${Date.now()}`, nome, texto };
  modelosCampanha.unshift(modelo);
  res.json({ sucesso: true, modelo });
});
app.post('/api/acao-cliente', async (req, res) => {
  try {
    const telefone = req.body.telefone;
    const acao = req.body.acao;
    if (acao === 'pix') { await enviarTexto(telefone, respostaQuantidade(Number(req.body.quantidade || 1))); await salvarContato({ telefone, status: 'aguardando_pagamento', ultima_mensagem: '[PIX reenviado]', interessado: true, quantidade: Number(req.body.quantidade || 1) }); }
    if (acao === 'dados') { await enviarTexto(telefone, respostaComprovante()); await salvarContato({ telefone, status: 'aguardando_dados', ultima_mensagem: '[dados solicitados]', interessado: true, comprovante: true }); }
    if (acao === 'finalizar') { await enviarTexto(telefone, agradecimentoFinal()); await salvarContato({ telefone, status: 'finalizado', ultima_mensagem: '[finalizado manualmente]' }); }
    res.json({ sucesso: true });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});
async function executarCampanha({ mensagem, limite, intervalo, filtro, telefonesSelecionados = [], nome = '', agendada = false }) {
  if (campanhaRodando) throw new Error('Campanha já está rodando');
  campanhaRodando = true;
  const contatos = await listarContatos();
  const selecionados = telefonesSelecionados.map(limparTelefone).filter(Boolean);
  const base = selecionados.length ? contatos.filter(c => selecionados.includes(limparTelefone(c.telefone))) : (filtro === 'todos' ? contatos : contatos.filter(c => (c.status || 'novo') === filtro));
  const alvo = base.slice(0, Number(limite || CONFIG.limitePadrao));
  const id = `CAMP-${new Date().toLocaleDateString('pt-BR').replace(/\D/g,'')}-${String(campanhaHistorico.length + 1).padStart(2,'0')}`;
  campanhaProgresso = { id, nome: nome || 'Campanha', total: alvo.length, enviados: 0, erros: 0, status: 'rodando', inicio: new Date().toISOString(), fim: null, agendada };
  campanhaAtual = campanhaProgresso;
  for (const c of alvo) {
    try { await enviarTexto(c.telefone, mensagem); campanhaProgresso.enviados++; await delay(Number(intervalo || CONFIG.intervaloPadrao)); }
    catch { campanhaProgresso.erros++; }
  }
  campanhaProgresso.status = 'finalizada'; campanhaProgresso.fim = new Date().toISOString(); campanhaRodando = false;
  campanhaHistorico.unshift({ ...campanhaProgresso }); campanhaHistorico = campanhaHistorico.slice(0, 10);
}
app.post('/api/campanha', async (req, res) => {
  try {
    const mensagem = String(req.body.mensagem || '').trim();
    if (!mensagem) return res.status(400).json({ sucesso: false, erro: 'Mensagem vazia' });
    const agendarEm = req.body.agendarEm ? new Date(req.body.agendarEm) : null;
    const payload = { mensagem, limite: req.body.limite, intervalo: req.body.intervalo, filtro: req.body.filtro || 'todos', telefonesSelecionados: req.body.telefonesSelecionados || [], nome: req.body.nome || '' };
    if (agendarEm && agendarEm.getTime() > Date.now() + 30000) {
      const ag = { id: `AG-${Date.now()}`, nome: payload.nome || 'Campanha agendada', horario: agendarEm.toISOString(), totalSelecionado: payload.telefonesSelecionados.length, status: 'agendada' };
      agendamentos.unshift(ag);
      setTimeout(async () => { ag.status = 'executando'; try { await executarCampanha({ ...payload, agendada: true }); ag.status = 'finalizada'; } catch (e) { ag.status = 'erro'; ag.erro = e.message; } }, agendarEm.getTime() - Date.now());
      return res.json({ sucesso: true, mensagem: 'Campanha agendada', agendamento: ag });
    }
    res.json({ sucesso: true, mensagem: 'Campanha iniciada' });
    executarCampanha(payload).catch(e => { campanhaRodando = false; campanhaProgresso.status = 'erro'; campanhaProgresso.erro = e.message; });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

function html() { return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reino Zap PRO</title><style>
*{box-sizing:border-box}body{margin:0;background:#081427;color:#fff;font-family:Arial,sans-serif}header{background:linear-gradient(135deg,#172554,#0f1b3d);padding:22px 16px;text-align:center;border-bottom:4px solid #3b63ff;position:sticky;top:0;z-index:5}h1{font-size:32px;margin:0}main{max-width:1180px;margin:auto;padding:14px}.nav{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}.nav button{background:#22345e}.grid{display:grid;grid-template-columns:1fr;gap:14px}.card{background:#151c31;border:1px solid #33415f;border-radius:18px;padding:16px;box-shadow:0 10px 30px #0003}h2{color:#aac7ff;font-size:23px;margin:0 0 12px}h3{margin:8px 0;color:#dbe7ff}input,textarea,select,button{width:100%;padding:13px;border-radius:12px;border:1px solid #40506e;background:#0a1426;color:#fff;font-size:15px;margin:7px 0}textarea{min-height:110px}button{border:0;background:#4f6bed;font-weight:bold;cursor:pointer}.danger{background:#d12d37}.orange{background:#e96f23}.green{background:#21a35b}.muted{color:#a7b4d4;font-size:13px}.box{background:#090e1e;border-radius:12px;padding:12px;margin-top:9px;white-space:pre-wrap;overflow:auto}.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.item{background:#0a1426;border:1px solid #3a4a68;border-radius:14px;padding:12px;margin-top:9px}.tag{display:inline-block;background:#3d4d89;padding:4px 9px;border-radius:99px;font-size:11px}.ok{color:#9dff91;font-weight:bold}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.progress{height:18px;border-radius:99px;background:#070b18;overflow:hidden;border:1px solid #273657}.bar{height:100%;background:linear-gradient(90deg,#4f6bed,#22c55e);width:0%}.contact{display:grid;grid-template-columns:26px 1fr;gap:8px;align-items:start}.contact input{width:auto;margin-top:8px}.actions{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.actions button{font-size:12px;padding:10px}.alert{position:fixed;right:12px;bottom:12px;background:#d12d37;color:white;padding:14px 16px;border-radius:14px;display:none;z-index:50;box-shadow:0 10px 30px #0008}@media(min-width:900px){.grid{grid-template-columns:1fr 1fr}.wide{grid-column:1/3}.kpi{grid-template-columns:repeat(6,1fr)}}
</style></head><body><header><h1>👑 Reino Zap PRO</h1><p>Painel profissional de vendas por WhatsApp V17</p></header><main>
<div class="nav"><button onclick="rolar('dash')">Dashboard</button><button onclick="rolar('camp')">Campanhas</button><button onclick="rolar('clientes')">Clientes</button><button onclick="rolar('atend')">Atendimento</button></div><div class="grid">
<section class="card" id="dash"><h2>1. WhatsApp</h2><div id="status">Carregando...</div><button onclick="atualizar()">Atualizar status</button><div id="qr"></div></section>
<section class="card"><h2>2. Envio rápido</h2><input id="telRapido" placeholder="Telefone"><textarea id="msgRapida">Teste Reino Zap ✅</textarea><button class="orange" onclick="enviarRapido()">Enviar mensagem</button><div id="retRapido" class="box"></div></section>
<section class="card wide" id="camp"><h2>3. Campanha / Oferta PRO</h2><p class="muted">Escolha uma campanha pronta ou salve uma nova. Sem separador confuso.</p><select id="modeloSelect" onchange="usarModelo()"></select><div class="row"><input id="nomeModelo" placeholder="Nome da campanha"><button class="green" onclick="salvarModelo()">Salvar campanha</button></div><textarea id="msgCamp" placeholder="Texto da campanha"></textarea><div class="row"><input id="limite" value="20" placeholder="Quantidade máxima"><input id="intervalo" value="8000" placeholder="Intervalo em milissegundos"></div><div class="row"><select id="filtro"><option value="todos">Todos</option><option value="novo">Novos</option><option value="respondeu">Responderam</option><option value="interessado">Interessados</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="aguardando_dados">Aguardando dados</option></select><input id="agendarEm" type="datetime-local" title="Agendar envio"></div><p class="muted">Para enviar só para contatos escolhidos, marque os clientes na área Clientes.</p><button class="danger" onclick="campanha()">Enviar / Agendar campanha</button><div class="box"><b>Progresso da campanha</b><div class="progress"><div id="progBar" class="bar"></div></div><div id="progTxt">Parado</div></div><div id="retCamp" class="box"></div></section>
<section class="card"><h2>4. Adicionar contato</h2><input id="nome" placeholder="Nome"><input id="telefone" placeholder="Telefone"><button onclick="addContato()">Salvar contato</button><div id="retContato" class="box"></div></section>
<section class="card" id="fluxo"><h2>5. Fluxo automático</h2><div class="box">Bilhete: R$ 2,00\nPix: 88994943632\nNome no Pix: G. DA SILVA\n\nCliente responde quantidade → sistema envia Pix.\nCliente manda imagem/PDF/paguei → sistema pede NOME e TELEFONE.\nCliente envia dados → entra em aguardando finalização.\nAtendente envia PDF → sistema agradece.\n\nSessão salva no Supabase.</div></section>
<section class="card"><h2>6. Última mensagem</h2><div id="ultima" class="box">-</div></section>
<section class="card wide"><h2>7. Últimas campanhas</h2><div id="campCards"></div><div id="agCards"></div></section>
<section class="card wide" id="clientes"><h2>8. Clientes / Seleção</h2><button onclick="carregarClientes()">Atualizar clientes</button><div class="row"><button onclick="marcarTodos(true)">Selecionar todos visíveis</button><button onclick="marcarTodos(false)">Limpar seleção</button></div><div class="kpi" id="kpis"></div><div id="lista"></div></section>
<section class="card wide" id="atend"><h2>9. Atendimento humanizado</h2><p class="muted">Clientes que exigem ação manual aparecem com destaque e alerta.</p><div id="filaAtendimento"></div></section>
</div></main><div id="alerta" class="alert">⚠️ Atendimento manual necessário</div><script>
const j=x=>JSON.stringify(x,null,2);let contatosCache=[];let modelos=[];let ultimaAlerta='';function rolar(id){document.getElementById(id).scrollIntoView({behavior:'smooth'})}async function api(u,o){let r=await fetch(u,o);return await r.json()}function beep(){try{let a=new (window.AudioContext||window.webkitAudioContext)();let o=a.createOscillator();let g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;o.start();g.gain.exponentialRampToValueAtTime(0.0001,a.currentTime+0.5);setTimeout(()=>a.close(),700)}catch(e){}}
async function carregarModelos(){let r=await api('/api/modelos');modelos=r.modelos||[];modeloSelect.innerHTML=modelos.map(m=>'<option value="'+m.id+'">'+m.nome+'</option>').join('');usarModelo()}function usarModelo(){let m=modelos.find(x=>x.id===modeloSelect.value)||modelos[0];if(m){nomeModelo.value=m.nome;msgCamp.value=m.texto}}
async function salvarModelo(){let r=await api('/api/modelos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nomeModelo.value,texto:msgCamp.value})});retCamp.innerText=j(r);carregarModelos()}
async function atualizar(){let s=await api('/status');status.innerHTML=s.conectado?'<p class="ok">WhatsApp conectado ✅<br>'+s.numeroConectado+'</p><p>Auth: '+s.auth+'</p>':'<p>WhatsApp desconectado</p><p>Auth: '+s.auth+'</p>';ultima.innerText=j(s.ultimaMensagemRecebida||'-');let q=await api('/qr');qr.innerHTML=q.qr?'<img src="'+q.qr+'" style="width:100%;max-width:300px;background:white;padding:10px">':'Sem QR no momento.';atualizarProgresso(s);carregarClientes(false)}
function atualizarProgresso(s){let p=s.campanhaProgresso||{};let pct=p.total?Math.round((p.enviados/p.total)*100):0;progBar.style.width=pct+'%';progTxt.innerText=(p.id||'Sem campanha')+' | '+(p.status||'parado')+' | '+(p.enviados||0)+'/'+(p.total||0)+' enviados | erros '+(p.erros||0)+' | '+pct+'%';campCards.innerHTML=(s.campanhaHistorico||[]).map(c=>'<div class="item"><b>'+c.id+'</b><br>'+new Date(c.inicio).toLocaleString('pt-BR')+'<br><span class="tag">'+c.status+'</span> Enviados: '+c.enviados+'/'+c.total+' Erros: '+c.erros+'</div>').join('')||'<div class="item">Nenhuma campanha finalizada ainda.</div>';agCards.innerHTML=(s.agendamentos||[]).map(a=>'<div class="item"><b>'+a.nome+'</b><br>'+new Date(a.horario).toLocaleString('pt-BR')+'<br><span class="tag">'+a.status+'</span></div>').join('')}
async function enviarRapido(){let r=await api('/api/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:telRapido.value,mensagem:msgRapida.value})});retRapido.innerText=j(r)}async function addContato(){let r=await api('/api/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nome.value,telefone:telefone.value})});retContato.innerText=j(r);carregarClientes()}
function selecionados(){return [...document.querySelectorAll('.selContato:checked')].map(x=>x.value)}function marcarTodos(v){document.querySelectorAll('.selContato').forEach(x=>x.checked=v)}async function campanha(){let r=await api('/api/campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nomeModelo.value,mensagem:msgCamp.value,limite:limite.value,intervalo:intervalo.value,filtro:filtro.value,agendarEm:agendarEm.value,telefonesSelecionados:selecionados()})});retCamp.innerText=j(r)}
async function acaoCliente(tel,acao){let q=prompt('Quantidade para Pix (se necessário):','1')||'1';let r=await api('/api/acao-cliente',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:tel,acao,quantidade:q})});alert(JSON.stringify(r))}
async function carregarClientes(force=true){let r=await api('/api/contatos');let cs=r.contatos||[];contatosCache=cs;let sts=['novo','respondeu','interessado','aguardando_pagamento','aguardando_dados','aguardando_finalizacao','finalizado'];kpis.innerHTML=sts.map(s=>'<div class="item"><b>'+cs.filter(c=>(c.status||'novo')===s).length+'</b><br><span class="tag">'+s+'</span></div>').join('');lista.innerHTML=cs.map(c=>'<div class="item contact"><input class="selContato" type="checkbox" value="'+c.telefone+'"><div><b>'+(c.nome||'Sem nome')+'</b><br>'+c.telefone+'<br><span class="tag">'+(c.status||'novo')+'</span><br>Última: '+(c.ultima_mensagem||'-')+'<div class="actions"><button onclick="acaoCliente(\''+c.telefone+'\',\'pix\')">Pix</button><button onclick="acaoCliente(\''+c.telefone+'\',\'dados\')">Dados</button><button onclick="acaoCliente(\''+c.telefone+'\',\'finalizar\')">Finalizar</button></div></div></div>').join('');let pend=cs.filter(c=>['aguardando_dados','aguardando_finalizacao','aguardando_pagamento'].includes(c.status));filaAtendimento.innerHTML=pend.map(c=>'<div class="item"><b>'+(c.nome||'Sem nome')+'</b><br>'+c.telefone+'<br><span class="tag">'+c.status+'</span><br>'+ (c.ultima_mensagem||'-') +'</div>').join('')||'<div class="item">Nenhum atendimento manual pendente.</div>';let chave=pend.map(c=>c.telefone+':'+c.status).join('|');if(chave && chave!==ultimaAlerta){ultimaAlerta=chave;alerta.style.display='block';beep();setTimeout(()=>alerta.style.display='none',6000)}}
carregarModelos();setInterval(atualizar,10000);atualizar();</script></body></html>`; }
app.get('/', (req, res) => res.redirect('/painel'));
app.get('/painel', (req, res) => res.send(html()));
app.listen(PORT, () => console.log('Reino Zap PRO V17 rodando na porta ' + PORT));
