import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  makeWASocket,
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
  versao: '17.1.0',
  bilheteValor: 2,
  pixChave: '88994943632',
  pixNome: 'G. DA SILVA',
  intervaloPadrao: 8000,
  limitePadrao: 20
};

let sock = null;
let qrAtual = '';
let qrDataUrl = '';
let conectado = false;
let numeroConectado = '';
let ultimaMensagem = null;
let campanhaRodando = false;
let campanhaProgresso = { total: 0, enviados: 0, erros: 0, percentual: 0, status: 'parado' };
let reconectando = false;

const memoria = {
  contatos: new Map(),
  mensagens: [],
  campanhas: [],
  campanhasHistorico: [],
  processadas: new Set(),
  respostasRecentes: new Map()
};

function limparTelefone(telefone = '') {
  return String(telefone)
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .replace(/:\d+@/, '@')
    .replace(/\D/g, '');
}

function jidDoNumero(telefone = '') {
  const limpo = limparTelefone(telefone);
  return `${limpo}@s.whatsapp.net`;
}

function moeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function textoNormalizado(v = '') {
  return String(v || '').trim().toLowerCase();
}

function detectarInteresse(texto = '') {
  const t = textoNormalizado(texto);
  if (!t) return false;
  const palavras = ['quero', 'comprar', 'participar', 'bilhete', 'bilhetes', 'pix', 'valor', 'manda', 'sim', 'vou querer', 'tenho interesse', 'quanto', 'pode ser', 'ok'];
  return palavras.some(p => t.includes(p));
}

function detectarQuantidade(texto = '') {
  const t = textoNormalizado(texto);
  const m = t.match(/\b(\d{1,4})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return null;
  return n;
}

function detectarDadosCliente(texto = '') {
  const raw = String(texto || '').trim();
  if (!raw) return false;
  const temTelefone = /\d{8,13}/.test(raw.replace(/\D/g, '')) || /telefone|fone|zap|whats/i.test(raw);
  const temNome = /nome/i.test(raw) || /^[a-záàâãéèêíóôõúç ]{3,}\s+\d{8,13}$/i.test(raw) || raw.split(/\n|\s{2,}/).length >= 2;
  return temTelefone && temNome;
}

function extrairTextoMensagem(message = {}) {
  return message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.documentMessage?.caption ||
    message.videoMessage?.caption ||
    '';
}

function detectarComprovante(msg, texto = '') {
  const m = msg?.message || {};
  const t = textoNormalizado(texto);
  const palavras = ['paguei', 'pago', 'comprovante', 'enviei', 'transferi', 'pix feito', 'pix enviado', 'segue pagamento'];
  if (m.documentMessage) return true;
  if (m.imageMessage && (palavras.some(p => t.includes(p)) || !t)) return true;
  return palavras.some(p => t.includes(p));
}

function detectarPdfDoAtendente(msg) {
  const m = msg?.message || {};
  return Boolean(msg?.key?.fromMe && m.documentMessage);
}

function respostaQuantidade(qtd) {
  const total = qtd * CONFIG.bilheteValor;
  return `Perfeito! 🎟️\n\nVocê escolheu: ${qtd} bilhete${qtd > 1 ? 's' : ''}\n\n💰 Total: ${moeda(total)}\n\n📲 Pagamento via Pix:\nChave: ${CONFIG.pixChave}\nNome: ${CONFIG.pixNome}\n\n⚠️ Envie o comprovante aqui para confirmar seu pedido.`;
}

function perguntaQuantidade() {
  return `Perfeito! 🎟️\n\nQuantos bilhetes você deseja comprar?\nDigite apenas o número.\n\nExemplo: 1, 2, 5, 10...`;
}

function respostaComprovante() {
  return `Recebido! ✅\n\n• Preencha os dados\nNOME:\nTELEFONE:\n\n⚠️ Aguarde o comprovante dos seus bilhetes`;
}

function respostaDadosRecebidos() {
  return `Dados recebidos! ✅\n\nSeu pedido foi enviado para finalização.\nAguarde o comprovante dos seus bilhetes.`;
}

function agradecimentoFinal() {
  return `REINO DA SORTE AGRADECE SUA COMPRA\n\n🍀 Boa Sorte 🍀`;
}

async function supabase(method, path, body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok) {
      const e = await r.text();
      console.log('Supabase erro:', method, path, e);
      return null;
    }
    if (r.status === 204) return null;
    try { return await r.json(); } catch { return null; }
  } catch (e) {
    console.log('Supabase falhou:', e.message);
    return null;
  }
}

async function carregarAuthItem(id) {
  const data = await supabase('GET', `zap_auth?id=eq.${encodeURIComponent(id)}&select=value&limit=1`);
  if (Array.isArray(data) && data[0]?.value !== undefined) {
    return JSON.parse(JSON.stringify(data[0].value), BufferJSON.reviver);
  }
  return null;
}

async function salvarAuthItem(id, value) {
  if (value === null || value === undefined) {
    await supabase('DELETE', `zap_auth?id=eq.${encodeURIComponent(id)}`);
    return;
  }
  const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  await supabase('POST', 'zap_auth?on_conflict=id', { id, value: json, updated_at: new Date().toISOString() });
}

async function useSupabaseAuthState() {
  const creds = await carregarAuthItem('creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await carregarAuthItem(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              tasks.push(salvarAuthItem(`${category}-${id}`, data[category][id]));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => salvarAuthItem('creds', creds)
  };
}

async function salvarContato({ telefone, nome = '', status = 'novo', ultima_mensagem = '', interessado = false, quantidade = null, comprovante = false, jid = '' }) {
  const tel = limparTelefone(telefone || jid);
  if (!tel) return;
  const atual = memoria.contatos.get(tel) || {};
  const contato = {
    telefone: tel,
    jid: jid || atual.jid || (tel.includes('@') ? tel : ''),
    nome: nome || atual.nome || '',
    status: status || atual.status || 'novo',
    ultima_mensagem: ultima_mensagem || atual.ultima_mensagem || '',
    interessado: Boolean(interessado || atual.interessado),
    quantidade: quantidade || atual.quantidade || null,
    comprovante: Boolean(comprovante || atual.comprovante)
  };
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
  if (Array.isArray(data)) {
    for (const c of data) memoria.contatos.set(limparTelefone(c.telefone), c);
    return data;
  }
  return Array.from(memoria.contatos.values()).reverse();
}

async function enviarTextoParaJid(jid, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  return await sock.sendMessage(jid, { text: texto });
}

async function enviarTexto(telefone, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  const jid = String(telefone).includes('@') ? telefone : jidDoNumero(telefone);
  let jidFinal = jid;
  try {
    const existe = await sock.onWhatsApp(jid);
    jidFinal = existe?.[0]?.jid || jid;
  } catch {}
  const resp = await sock.sendMessage(jidFinal, { text: texto });
  return { jid: jidFinal, resposta: resp };
}

function podeResponder(chave, ms = 90000) {
  const agora = Date.now();
  const ultimo = memoria.respostasRecentes.get(chave) || 0;
  if (agora - ultimo < ms) return false;
  memoria.respostasRecentes.set(chave, agora);
  return true;
}

async function iniciarWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState();
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Reino Zap PRO', 'Chrome', '17.1.0'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrAtual = qr;
      qrDataUrl = await QRCode.toDataURL(qr);
      conectado = false;
    }
    if (connection === 'open') {
      conectado = true;
      qrAtual = '';
      qrDataUrl = '';
      numeroConectado = sock.user?.id || '';
      console.log('WhatsApp conectado:', numeroConectado);
    }
    if (connection === 'close') {
      conectado = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log('WhatsApp desconectado:', reason);
      if (reason !== DisconnectReason.loggedOut && !reconectando) {
        reconectando = true;
        setTimeout(async () => { reconectando = false; await iniciarWhatsApp(); }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages || []) {
      try {
        if (!msg.message) continue;
        const msgId = msg.key?.id || `${msg.key?.remoteJid}-${msg.messageTimestamp}`;
        if (memoria.processadas.has(msgId)) continue;
        memoria.processadas.add(msgId);
        if (memoria.processadas.size > 3000) memoria.processadas.clear();

        const fromMe = Boolean(msg.key?.fromMe);
        const jid = msg.key?.remoteJid || '';
        const telefone = limparTelefone(jid);
        const texto = extrairTextoMensagem(msg.message);
        const comprovante = detectarComprovante(msg, texto);
        const qtd = detectarQuantidade(texto);
        const dadosCliente = detectarDadosCliente(texto);
        const interessado = detectarInteresse(texto) || Boolean(qtd);

        ultimaMensagem = { de: jid, telefone, mensagem: texto || '[mídia]', tipo: comprovante ? 'comprovante/midia' : 'texto', interessado, quantidade: qtd, comprovante, data: new Date().toISOString() };

        if (fromMe) {
          if (detectarPdfDoAtendente(msg) && podeResponder(`pdf-${jid}`, 120000)) {
            await enviarTextoParaJid(jid, agradecimentoFinal());
            await salvarContato({ telefone, jid, status: 'finalizado', ultima_mensagem: '[PDF enviado pelo atendente]' });
          }
          continue;
        }

        await salvarResposta({ telefone, mensagem: texto || '[mídia/comprovante]', interessado });

        if (comprovante) {
          await salvarContato({ telefone, jid, status: 'aguardando_dados', ultima_mensagem: texto || '[comprovante]', interessado: true, comprovante: true });
          if (podeResponder(`comprovante-${jid}`)) await enviarTextoParaJid(jid, respostaComprovante());
          continue;
        }

        if (dadosCliente) {
          await salvarContato({ telefone, jid, status: 'aguardando_finalizacao', ultima_mensagem: texto, interessado: true });
          if (podeResponder(`dados-${jid}`)) await enviarTextoParaJid(jid, respostaDadosRecebidos());
          continue;
        }

        if (qtd) {
          await salvarContato({ telefone, jid, status: 'aguardando_pagamento', ultima_mensagem: texto, interessado: true, quantidade: qtd });
          if (podeResponder(`qtd-${jid}-${qtd}`)) await enviarTextoParaJid(jid, respostaQuantidade(qtd));
          continue;
        }

        if (interessado) {
          await salvarContato({ telefone, jid, status: 'interessado', ultima_mensagem: texto, interessado: true });
          if (podeResponder(`interesse-${jid}`)) await enviarTextoParaJid(jid, perguntaQuantidade());
        } else {
          await salvarContato({ telefone, jid, status: 'respondeu', ultima_mensagem: texto, interessado: false });
        }
      } catch (e) { console.log('Erro processando mensagem:', e.message); }
    }
  });
}

iniciarWhatsApp().catch(e => console.log('Erro ao iniciar WhatsApp:', e.message));

app.get('/status', (req, res) => res.json({ online: true, sistema: CONFIG.sistema, versao: CONFIG.versao, conectado, numeroConectado, temQr: Boolean(qrDataUrl), auth: 'supabase', ultimaMensagemRecebida: ultimaMensagem, campanhaProgresso }));
app.get('/qr', (req, res) => res.json({ conectado, numeroConectado, qr: qrDataUrl }));
app.get('/api/contatos', async (req, res) => res.json({ sucesso: true, contatos: await listarContatos() }));
app.post('/api/contatos', async (req, res) => { await salvarContato({ telefone: req.body.telefone, nome: req.body.nome, status: 'novo' }); res.json({ sucesso: true }); });
app.post('/api/enviar', async (req, res) => { try { const envio = await enviarTexto(req.body.telefone, req.body.mensagem); res.json({ sucesso: true, envio }); } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); } });
app.post('/api/cliente/acao', async (req, res) => {
  try {
    const { telefone, acao } = req.body;
    if (acao === 'pix') await enviarTexto(telefone, perguntaQuantidade());
    if (acao === 'dados') await enviarTexto(telefone, respostaComprovante());
    if (acao === 'finalizar') await enviarTexto(telefone, agradecimentoFinal());
    const status = acao === 'finalizar' ? 'finalizado' : acao === 'dados' ? 'aguardando_dados' : 'aguardando_pagamento';
    await salvarContato({ telefone, status, ultima_mensagem: `[ação: ${acao}]`, interessado: true });
    res.json({ sucesso: true });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});
app.post('/api/campanhas/salvar', (req, res) => {
  const nome = String(req.body.nome || '').trim() || `Campanha ${memoria.campanhas.length + 1}`;
  const texto = String(req.body.texto || '').trim();
  if (!texto) return res.status(400).json({ sucesso: false, erro: 'Mensagem vazia' });
  const campanha = { id: Date.now().toString(), nome, texto, criada_em: new Date().toISOString() };
  memoria.campanhas.unshift(campanha);
  res.json({ sucesso: true, campanha, campanhas: memoria.campanhas });
});
app.get('/api/campanhas', (req, res) => res.json({ sucesso: true, campanhas: memoria.campanhas, historico: memoria.campanhasHistorico, progresso: campanhaProgresso }));
app.post('/api/campanha', async (req, res) => {
  if (campanhaRodando) return res.status(409).json({ sucesso: false, erro: 'Campanha já está rodando' });
  const contatos = await listarContatos();
  const selecionados = Array.isArray(req.body.telefones) ? req.body.telefones.map(limparTelefone).filter(Boolean) : [];
  const filtroStatus = req.body.status || 'todos';
  let alvo = contatos.filter(c => selecionados.length ? selecionados.includes(limparTelefone(c.telefone)) : true);
  if (filtroStatus !== 'todos') alvo = alvo.filter(c => (c.status || 'novo') === filtroStatus);
  const limite = Number(req.body.limite || CONFIG.limitePadrao);
  const intervalo = Number(req.body.intervalo || CONFIG.intervaloPadrao);
  alvo = alvo.slice(0, limite);
  const textos = Array.isArray(req.body.textos) && req.body.textos.length ? req.body.textos : [String(req.body.mensagem || '').trim()].filter(Boolean);
  const mensagemPadrao = '🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.';
  const inicio = new Date();
  campanhaRodando = true;
  campanhaProgresso = { total: alvo.length, enviados: 0, erros: 0, percentual: 0, status: 'rodando', inicio: inicio.toISOString() };
  const registro = { id: Date.now().toString(), inicio: inicio.toISOString(), total: alvo.length, enviados: 0, erros: 0, status: 'rodando' };
  memoria.campanhasHistorico.unshift(registro);
  res.json({ sucesso: true, mensagem: 'Campanha iniciada', total: alvo.length });
  for (const c of alvo) {
    try {
      const texto = textos[Math.floor(Math.random() * textos.length)] || mensagemPadrao;
      await enviarTexto(c.telefone || c.jid, texto);
      campanhaProgresso.enviados++;
      registro.enviados++;
      campanhaProgresso.percentual = campanhaProgresso.total ? Math.round((campanhaProgresso.enviados / campanhaProgresso.total) * 100) : 100;
      await delay(intervalo);
    } catch { campanhaProgresso.erros++; registro.erros++; }
  }
  campanhaProgresso.status = 'finalizada'; registro.status = 'finalizada'; registro.fim = new Date().toISOString(); campanhaRodando = false;
});

function html() { return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reino Zap PRO</title><style>
*{box-sizing:border-box}body{margin:0;background:#081427;color:#fff;font-family:Arial,sans-serif}header{background:#172554;padding:24px 16px;text-align:center;border-bottom:4px solid #3b63ff}h1{font-size:34px;margin:0}main{max-width:1180px;margin:auto;padding:16px}.grid{display:grid;grid-template-columns:1fr;gap:16px}.card{background:#151c31;border:1px solid #33415f;border-radius:18px;padding:16px}h2{color:#aac7ff;font-size:24px;margin:0 0 14px}input,textarea,select,button{width:100%;padding:14px;border-radius:12px;border:1px solid #40506e;background:#0a1426;color:#fff;font-size:16px;margin:7px 0}textarea{min-height:110px}button{border:0;background:#4f6bed;font-weight:bold;cursor:pointer}.danger{background:#d12d37}.orange{background:#e96f23}.green{background:#22a95a}.box{background:#090e1e;border-radius:12px;padding:13px;margin-top:10px;white-space:pre-wrap}.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.item{background:#0a1426;border:1px solid #3a4a68;border-radius:14px;padding:13px;margin-top:10px}.tag{display:inline-block;background:#3d4d89;padding:5px 10px;border-radius:99px;font-size:12px}.ok{color:#9dff91;font-weight:bold}.nav{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}.nav button{background:#22345e}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.progress{height:18px;border-radius:99px;background:#061022;border:1px solid #33415f;overflow:hidden}.bar{height:100%;background:#35d07f;width:0%}.cliente{position:relative}.cliente input{width:auto;margin-right:8px}.acoes{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.acoes button{font-size:12px;padding:10px}.manual{border-color:#fbbf24;box-shadow:0 0 0 1px #fbbf24}.alerta{background:#f59e0b;color:#111;padding:10px;border-radius:12px;margin:8px 0;font-weight:bold;display:none}@media(min-width:900px){.grid{grid-template-columns:1fr 1fr}.wide{grid-column:1/3}}
</style></head><body><header><h1>👑 Reino Zap PRO</h1><p>Painel profissional de vendas por WhatsApp V17.1</p></header><main>
<div class="nav"><button onclick="rolar('dash')">Dashboard</button><button onclick="rolar('camp')">Campanhas</button><button onclick="rolar('clientes')">Clientes</button><button onclick="rolar('atendimento')">Atendimento</button></div>
<div id="alerta" class="alerta">🔔 Cliente aguardando atendimento manual</div><div class="grid">
<section class="card" id="dash"><h2>1. WhatsApp</h2><div id="status">Carregando...</div><button onclick="atualizar()">Atualizar status</button><div id="qr"></div></section>
<section class="card"><h2>2. Envio rápido</h2><input id="telRapido" placeholder="Telefone"><textarea id="msgRapida">Teste Reino Zap ✅</textarea><button class="orange" onclick="enviarRapido()">Enviar mensagem</button><div id="retRapido" class="box"></div></section>
<section class="card wide" id="camp"><h2>3. Campanha / Oferta PRO</h2><p>Escolha campanha pronta ou salve uma nova. Sem separador confuso.</p><select id="campanhaSelect" onchange="selecionarCampanha()"></select><div class="row"><input id="campNome" placeholder="Nome da campanha"><button class="green" onclick="salvarCampanha()">Salvar campanha</button></div><textarea id="msgCamp">🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.</textarea><div class="row"><input id="limite" value="20" placeholder="Limite"><input id="intervalo" value="8000" placeholder="Intervalo ms"></div><div class="row"><select id="filtroStatus"><option value="todos">Todos</option><option value="novo">Novos</option><option value="respondeu">Responderam</option><option value="interessado">Interessados</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="aguardando_dados">Aguardando dados</option><option value="aguardando_finalizacao">Aguardando finalização</option></select><input id="agendamento" type="datetime-local"></div><p>Para enviar só para contatos escolhidos, marque os clientes na área Clientes.</p><button class="danger" onclick="campanha()">Enviar / Agendar campanha</button><div class="box"><b>Progresso da campanha</b><div class="progress"><div id="barra" class="bar"></div></div><span id="progTexto">Parado</span></div><div id="retCamp" class="box"></div></section>
<section class="card"><h2>4. Adicionar contato</h2><input id="nome" placeholder="Nome"><input id="telefone" placeholder="Telefone"><button onclick="addContato()">Salvar contato</button><div id="retContato" class="box"></div></section>
<section class="card" id="fluxo"><h2>5. Fluxo automático</h2><div class="box">Bilhete: R$ 2,00\nPix: 88994943632\nNome no Pix: G. DA SILVA\n\nCliente responde quantidade → sistema envia Pix.\nCliente manda imagem/PDF/paguei → sistema pede NOME e TELEFONE.\nCliente envia dados → entra em aguardando finalização.\nAtendente envia PDF → sistema agradece.\n\nSessão salva no Supabase.</div></section>
<section class="card wide"><h2>6. Última mensagem</h2><div id="ultima" class="box">-</div></section>
<section class="card wide"><h2>7. Últimas campanhas</h2><div id="historico"></div></section>
<section class="card wide" id="clientes"><h2>8. Clientes / Seleção</h2><button onclick="carregarClientes()">Atualizar clientes</button><div class="row"><button onclick="selecionarVisiveis()">Selecionar todos visíveis</button><button onclick="limparSelecao()">Limpar seleção</button></div><div class="kpi" id="kpis"></div><div id="lista"></div></section>
<section class="card wide" id="atendimento"><h2>9. Atendimento humanizado</h2><p>Clientes que exigem ação manual aparecem com destaque e alerta.</p><div id="manual"></div></section>
</div></main><script>
const $=id=>document.getElementById(id);const j=x=>JSON.stringify(x,null,2);let contatosCache=[];let campanhasCache=[];let selecionados=new Set();let audioOk=false;function beep(){try{const a=new (window.AudioContext||window.webkitAudioContext)();const o=a.createOscillator();const g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.05;o.start();setTimeout(()=>{o.stop();a.close()},300)}catch(e){}}
function rolar(id){$(id).scrollIntoView({behavior:'smooth'})}async function api(u,o){let r=await fetch(u,o);let t=await r.text();try{return JSON.parse(t)}catch{return {sucesso:false,erro:t,status:r.status}}}
async function atualizar(){try{let s=await api('/status');$('status').innerHTML=s.conectado?'<p class="ok">WhatsApp conectado ✅<br>'+s.numeroConectado+'</p><small>Auth: '+(s.auth||'-')+'</small>':'<p>WhatsApp desconectado</p>';$('ultima').innerText=j(s.ultimaMensagemRecebida||'-');let p=s.campanhaProgresso||{};$('barra').style.width=(p.percentual||0)+'%';$('progTexto').innerText=(p.status||'parado')+' - '+(p.enviados||0)+'/'+(p.total||0)+' erros: '+(p.erros||0);let q=await api('/qr');$('qr').innerHTML=q.qr?'<img src="'+q.qr+'" style="width:100%;max-width:300px;background:#fff;padding:8px">':'Sem QR no momento.';await carregarCampanhas();await carregarClientes(false)}catch(e){$('status').innerHTML='<b>Falha ao atualizar painel</b><br>'+e.message}}
async function enviarRapido(){let r=await api('/api/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:$('telRapido').value,mensagem:$('msgRapida').value})});$('retRapido').innerText=j(r)}
async function addContato(){let r=await api('/api/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:$('nome').value,telefone:$('telefone').value})});$('retContato').innerText=j(r);carregarClientes()}
async function salvarCampanha(){let r=await api('/api/campanhas/salvar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:$('campNome').value,texto:$('msgCamp').value})});$('retCamp').innerText=j(r);carregarCampanhas()}
function selecionarCampanha(){let id=$('campanhaSelect').value;let c=campanhasCache.find(x=>x.id===id);if(c){$('campNome').value=c.nome;$('msgCamp').value=c.texto}}
async function carregarCampanhas(){let r=await api('/api/campanhas');campanhasCache=r.campanhas||[];$('campanhaSelect').innerHTML='<option value="">Escolha uma campanha salva</option>'+campanhasCache.map(c=>'<option value="'+c.id+'">'+c.nome+'</option>').join('');$('historico').innerHTML=(r.historico||[]).slice(0,5).map(h=>'<div class="item"><b>#'+h.id.slice(-4)+'</b><br>Início: '+new Date(h.inicio).toLocaleString('pt-BR')+'<br>Total: '+h.total+' | Enviados: '+h.enviados+' | Erros: '+h.erros+'<br><span class="tag">'+h.status+'</span></div>').join('')||'<div class="item">Nenhuma campanha ainda.</div>'}
async function campanha(){const quando=$('agendamento').value?new Date($('agendamento').value).getTime():0;const agora=Date.now();if(quando&&quando>agora){$('retCamp').innerText='Campanha agendada para '+new Date(quando).toLocaleString('pt-BR');setTimeout(campanha,quando-agora);return}let r=await api('/api/campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem:$('msgCamp').value,limite:$('limite').value,intervalo:$('intervalo').value,status:$('filtroStatus').value,telefones:[...selecionados]})});$('retCamp').innerText=j(r)}
function selecionarVisiveis(){contatosCache.forEach(c=>selecionados.add(String(c.telefone)));renderClientes()}function limparSelecao(){selecionados.clear();renderClientes()}function toggleSel(t){selecionados.has(t)?selecionados.delete(t):selecionados.add(t);renderClientes()}
async function acaoCliente(t,acao){let r=await api('/api/cliente/acao',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:t,acao})});alert(r.sucesso?'Ação enviada':'Erro: '+r.erro);carregarClientes()}
async function carregarClientes(render=true){let r=await api('/api/contatos');contatosCache=r.contatos||[];renderClientes()}
function renderClientes(){let cs=contatosCache;let sts=['novo','respondeu','interessado','aguardando_pagamento','aguardando_dados','aguardando_finalizacao','finalizado'];$('kpis').innerHTML=sts.map(s=>'<div class="item"><b>'+cs.filter(c=>(c.status||'novo')===s).length+'</b><br><span class="tag">'+s+'</span></div>').join('');$('lista').innerHTML=cs.map(c=>{let t=String(c.telefone);let manual=['aguardando_dados','aguardando_finalizacao'].includes(c.status);return '<div class="item cliente '+(manual?'manual':'')+'"><label><input type="checkbox" '+(selecionados.has(t)?'checked':'')+' onchange="toggleSel(\''+t+'\')"> <b>'+(c.nome||'Sem nome')+'</b></label><br>'+t+'<br><span class="tag">'+(c.status||'novo')+'</span><br>Última: '+(c.ultima_mensagem||'-')+'<div class="acoes"><button onclick="acaoCliente(\''+t+'\',\'pix\')">Pix</button><button onclick="acaoCliente(\''+t+'\',\'dados\')">Dados</button><button onclick="acaoCliente(\''+t+'\',\'finalizar\')">Finalizar</button></div></div>'}).join('');let man=cs.filter(c=>['aguardando_dados','aguardando_finalizacao'].includes(c.status));$('manual').innerHTML=man.map(c=>'<div class="item manual"><b>'+(c.nome||'Sem nome')+'</b><br>'+c.telefone+'<br><span class="tag">'+c.status+'</span><br>'+c.ultima_mensagem+'</div>').join('')||'<div class="item">Nenhum atendimento pendente.</div>';$('alerta').style.display=man.length?'block':'none';if(man.length&&!audioOk){beep();audioOk=true}if(!man.length)audioOk=false}
setInterval(atualizar,10000);atualizar();</script></body></html>`; }
app.get('/', (req, res) => res.redirect('/painel'));
app.get('/painel', (req, res) => res.send(html()));
app.listen(PORT, () => console.log('Reino Zap PRO V17.1 rodando na porta ' + PORT));
