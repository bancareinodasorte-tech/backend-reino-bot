
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
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN || '';
const PAGBANK_BASE_URL = process.env.PAGBANK_BASE_URL || 'https://api.pagseguro.com';

const CONFIG = {
  sistema: 'Reino Zap PRO',
  versao: '17.7 OPERACIONAL',
  bilheteValor: 2,
  pixChave: process.env.PIX_CHAVE || '88994943632',
  pixNome: process.env.PIX_NOME || 'G. DA SILVA',
  suporteTexto: 'https://wa.me/5588994943632',
  intervaloPadrao: 3000,
  limitePadrao: 20,
  validadeCampanhaMinutos: 60
};

let sock = null;
let qrDataUrl = '';
let conectado = false;
let numeroConectado = '';
let ultimaMensagem = null;
let campanhaRodando = false;
let iniciando = false;

let campanhaProgresso = {
  id: null, total: 0, enviados: 0, erros: 0, expirados: 0,
  respostas: 0, compras: 0, status: 'parado', inicio: null, fim: null
};

const memoria = {
  contatos: new Map(),
  mensagens: [],
  campanhas: [],
  campanhasSalvas: [],
  fila: []
};

const processadas = new Map();
const cooldown = new Map();
const travasEnvio = new Map();

function agoraIso() { return new Date().toISOString(); }
function limparTelefone(telefone = '') { return String(telefone).replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, ''); }
function normalizarTelefoneBR(telefone = '') {
  let n = limparTelefone(telefone);
  if (!n) return '';
  if (n.startsWith('00')) n = n.slice(2);
  if (!n.startsWith('55') && (n.length === 10 || n.length === 11)) n = '55' + n;
  return n;
}
function validarTelefoneBR(telefone = '') {
  const n = normalizarTelefoneBR(telefone);
  if (!/^55\d{10,11}$/.test(n)) return { ok: false, telefone: n, erro: 'Telefone inválido. Use DDD + número. Exemplo: 88994943632' };
  const ddd = n.slice(2, 4);
  const numero = n.slice(4);
  if (Number(ddd) < 11 || Number(ddd) > 99) return { ok: false, telefone: n, erro: 'DDD inválido.' };
  if (!(numero.length === 8 || numero.length === 9)) return { ok: false, telefone: n, erro: 'Número precisa ter 8 ou 9 dígitos depois do DDD.' };
  return { ok: true, telefone: n };
}
function jidDoNumero(telefone = '') { return `${normalizarTelefoneBR(telefone)}@s.whatsapp.net`; }
function moeda(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function textoNormalizado(v = '') { return String(v || '').trim().toLowerCase(); }
function dataHumana(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const agora = new Date();
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
  const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (dia === hoje) return `Hoje ${hh}:${mm}`;
  if (dia === hoje - 86400000) return `Ontem ${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} — ${hh}:${mm}`;
}
function detectarInteresse(texto = '') {
  const t = textoNormalizado(texto);
  if (!t) return false;
  return ['quero','comprar','participar','bilhete','bilhetes','pix','valor','manda','sim','vou querer','tenho interesse','quanto','pode ser','ok'].some(p => t.includes(p));
}
function detectarQuantidade(texto = '') {
  const m = textoNormalizado(texto).match(/\b(\d{1,4})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
}
function extrairTextoMensagem(message = {}) {
  return message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.documentMessage?.caption || message.videoMessage?.caption || '';
}
function detectarComprovante(msg, texto = '') {
  const m = msg?.message || {};
  const t = textoNormalizado(texto);
  const temMidia = Boolean(m.imageMessage || m.documentMessage);
  const nomeDoc = textoNormalizado(m.documentMessage?.fileName || '');
  const falaPagamento = ['paguei','pago','comprovante','enviei','transferi','pix feito','segue comprovante','feito o pix','pix'].some(p => t.includes(p) || nomeDoc.includes(p));
  // Correção: mídia sem texto claro NÃO entra como comprovante automaticamente.
  return Boolean((temMidia && falaPagamento) || (!temMidia && falaPagamento));
}
function detectarPdfBilheteFinal(msg) {
  const m = msg?.message || {};
  if (!msg?.key?.fromMe || !m.documentMessage) return false;
  const nome = textoNormalizado(m.documentMessage.fileName || '');
  const mime = textoNormalizado(m.documentMessage.mimetype || '');
  return mime.includes('pdf') && ['bilhete','bilhetes','reino','sorte','comprovante-bilhete'].some(p => nome.includes(p));
}
function respostaQuantidade(qtd, pixTexto = '') {
  const base = `Perfeito! 🎟️\n\nVocê escolheu: ${qtd} bilhete${qtd > 1 ? 's' : ''}\n\n💰 Total: ${moeda(qtd * CONFIG.bilheteValor)}\n\n📲 Pagamento via Pix:\nChave: ${CONFIG.pixChave}\nNome: ${CONFIG.pixNome}`;
  return `${base}${pixTexto ? `\n\n${pixTexto}` : ''}\n\n⚠️ Envie o comprovante aqui para confirmar seu pedido.`;
}
function perguntaQuantidade() { return `Perfeito! 🎟️\n\nQuantos bilhetes você deseja comprar?\nDigite apenas o número.\n\nExemplo: 1, 2, 5, 10...`; }
function respostaComprovante() { return `Recebido! ✅\n\n• Preencha os dados\nNOME:\nTELEFONE:\n\n⚠️ Aguarde o comprovante dos seus bilhetes`; }
function dadosRecebidos() { return `Dados recebidos ✅\n\nSeu pedido foi encaminhado para finalização.\nAguarde o comprovante dos seus bilhetes.`; }
function telefoneIncorreto() { return `O telefone informado parece estar incompleto ou incorreto.\n\nEnvie novamente assim:\nNOME: Seu nome\nTELEFONE: DDD + número\n\nExemplo:\nNOME: João Silva\nTELEFONE: 88994943632`; }
function mensagemForaDoFluxo() { return `Este CANAL é exclusivo para compras de bilhetes do Reino da Sorte 🎟️\n\n1. Para continuar a compra digite somente a quantidade de bilhetes:\n\n2) Para outros assuntos clique 👇:\nhttps://wa.me/5588994943632`; }
function agradecimentoFinal() { return `REINO DA SORTE AGRADECE SUA COMPRA\n\n🍀 Boa Sorte 🍀`; }
function extrairDadosCliente(texto = '') {
  const bruto = String(texto || '').trim();
  const telefoneMatch = bruto.match(/(?:telefone|tel|whats|whatsapp)?\D*((?:55)?\d{10,13})/i);
  const tel = telefoneMatch ? telefoneMatch[1] : '';
  const validacao = validarTelefoneBR(tel);
  let nome = bruto
    .replace(/telefone\s*:?.*/ig,'')
    .replace(/tel\s*:?.*/ig,'')
    .replace(/whats\s*:?.*/ig,'')
    .replace(/whatsapp\s*:?.*/ig,'')
    .replace(/\d{8,13}/g,'')
    .replace(/nome\s*:?/ig,'')
    .trim();
  nome = nome.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
  return { nome: nome.length >= 2 ? nome : '', telefone: validacao.telefone, telefoneOk: validacao.ok };
}

async function supabase(method, path, body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
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
    console.log('Supabase erro:', method, path, await r.text());
    return null;
  }
  if (r.status === 204) return null;
  try { return await r.json(); } catch { return null; }
}
async function authRead(id) {
  const data = await supabase('GET', `zap_auth?select=value&id=eq.${encodeURIComponent(id)}&limit=1`);
  const row = Array.isArray(data) ? data[0] : null;
  return row ? JSON.parse(JSON.stringify(row.value), BufferJSON.reviver) : null;
}
async function authWrite(id, value) {
  const safe = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  await supabase('POST', 'zap_auth?on_conflict=id', { id, value: safe, updated_at: agoraIso() });
}
async function authDelete(id) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/zap_auth?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
}
async function authClearAll() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/zap_auth?id=not.is.null`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
}
async function useSupabaseAuthState() {
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
        set: async data => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              tasks.push(value ? authWrite(`${category}-${id}`, value) : authDelete(`${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => authWrite('creds', creds)
  };
}

async function salvarContato({ telefone, nome = '', status = 'novo', ultima_mensagem = '', interessado = false, quantidade = null, comprovante = false, lista = '', finalizado = false }) {
  const valid = validarTelefoneBR(telefone);
  const tel = valid.ok ? valid.telefone : limparTelefone(telefone);
  if (!tel) return null;
  const atual = memoria.contatos.get(tel) || {};
  const contato = {
    telefone: tel,
    nome: nome || atual.nome || '',
    status: status || atual.status || 'novo',
    lista: lista || atual.lista || '',
    ultima_mensagem: ultima_mensagem || atual.ultima_mensagem || '',
    interessado: Boolean(interessado || atual.interessado),
    quantidade: quantidade || atual.quantidade || null,
    comprovante: Boolean(comprovante || atual.comprovante),
    finalizado: Boolean(finalizado || atual.finalizado),
    atualizado_em: agoraIso()
  };
  memoria.contatos.set(tel, contato);
  await supabase('POST', 'contatos?on_conflict=telefone', contato);
  return contato;
}
async function salvarResposta({ telefone, mensagem, interessado = false }) {
  const tel = normalizarTelefoneBR(telefone) || limparTelefone(telefone);
  const item = { telefone: tel, mensagem, interessado, criado_em: agoraIso(), horario: dataHumana(agoraIso()) };
  memoria.mensagens.unshift(item);
  memoria.mensagens = memoria.mensagens.slice(0, 300);
  await supabase('POST', 'respostas', { telefone: tel, mensagem, interessado, criado_em: item.criado_em });
  if (interessado) await supabase('POST', 'interessados', { telefone: tel, origem: 'whatsapp', criado_em: item.criado_em });
}
async function listarContatos() {
  const data = await supabase('GET', 'contatos?select=*&order=atualizado_em.desc');
  if (Array.isArray(data)) {
    data.forEach(c => memoria.contatos.set(c.telefone, c));
    return data.map(c => ({ ...c, horario: dataHumana(c.atualizado_em || c.created_at) }));
  }
  return Array.from(memoria.contatos.values()).reverse().map(c => ({ ...c, horario: dataHumana(c.atualizado_em) }));
}
async function obterContato(telefone) {
  const tel = normalizarTelefoneBR(telefone) || limparTelefone(telefone);
  if (memoria.contatos.has(tel)) return memoria.contatos.get(tel);
  const data = await supabase('GET', `contatos?select=*&telefone=eq.${encodeURIComponent(tel)}&limit=1`);
  if (Array.isArray(data) && data[0]) {
    memoria.contatos.set(tel, data[0]);
    return data[0];
  }
  return null;
}
async function gerarPixPedido(qtd, telefone) {
  const valor = qtd * CONFIG.bilheteValor;
  if (!PAGBANK_TOKEN) {
    return { modo: 'chave_fixa', valor, texto: '', aviso: 'PagBank ainda sem token configurado. Usando chave PIX fixa.' };
  }
  // Estrutura reservada para PagBank real. Sem credenciais válidas, não força erro no fluxo.
  return { modo: 'pagbank_configurado', valor, texto: '', aviso: 'PagBank token detectado. Integração de cobrança será ativada na etapa de credenciais/webhook.' };
}
async function enviarTextoDestino(destino, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  let jidFinal = destino;
  if (!String(destino).includes('@')) {
    const valid = validarTelefoneBR(destino);
    if (!valid.ok) throw new Error(valid.erro);
    const jid = jidDoNumero(valid.telefone);
    const existe = await sock.onWhatsApp(jid);
    jidFinal = existe?.[0]?.jid || jid;
  }
  const chaveTrava = `${jidFinal}|${String(texto).slice(0,80)}`;
  const agora = Date.now();
  if (travasEnvio.has(chaveTrava) && agora - travasEnvio.get(chaveTrava) < 2500) {
    return { jid: jidFinal, duplicadoBloqueado: true };
  }
  travasEnvio.set(chaveTrava, agora);
  setTimeout(() => travasEnvio.delete(chaveTrava), 10000);
  const resp = await sock.sendMessage(jidFinal, { text: texto });
  return { jid: jidFinal, resposta: resp };
}
async function enviarMidiaDestino(destino, arquivoBase64, nomeArquivo, mimetype, legenda = '') {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  const valid = validarTelefoneBR(destino);
  if (!valid.ok) throw new Error(valid.erro);
  const jid = jidDoNumero(valid.telefone);
  const buffer = Buffer.from(String(arquivoBase64).split(',').pop(), 'base64');
  const tipo = String(mimetype || '').startsWith('image/') ? { image: buffer, caption: legenda } : { document: buffer, fileName: nomeArquivo || 'arquivo.pdf', mimetype: mimetype || 'application/pdf', caption: legenda };
  return await sock.sendMessage(jid, tipo);
}

async function reiniciarSocket() {
  try { sock?.ws?.close?.(); } catch {}
  sock = null; conectado = false; qrDataUrl = ''; numeroConectado = ''; iniciando = false;
  setTimeout(iniciarWhatsApp, 1000);
}
async function iniciarWhatsApp() {
  if (iniciando || sock) return;
  iniciando = true;
  try {
    const { state, saveCreds } = await useSupabaseAuthState();
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Reino Zap PRO', 'Chrome', '17.7']
    });
    iniciando = false;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrDataUrl = await QRCode.toDataURL(qr); conectado = false; }
      if (connection === 'open') { conectado = true; qrDataUrl = ''; numeroConectado = sock.user?.id || ''; console.log('WhatsApp conectado:', numeroConectado); }
      if (connection === 'close') {
        conectado = false; sock = null; qrDataUrl = '';
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log('WhatsApp desconectado:', reason);
        if (reason === DisconnectReason.loggedOut || reason === 401) {
          console.log('Sessão expirada. Limpando auth e reiniciando para gerar QR.');
          await authClearAll();
          setTimeout(iniciarWhatsApp, 2500);
        } else {
          setTimeout(iniciarWhatsApp, 3000);
        }
      }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages || []) {
        try { await processarMensagem(msg); } catch(e) { console.log('Erro processando mensagem:', e.message); }
      }
    });
  } catch (e) {
    sock = null; iniciando = false;
    console.log('Erro ao iniciar WhatsApp:', e.message);
    setTimeout(iniciarWhatsApp, 5000);
  }
}
async function processarMensagem(msg) {
  if (!msg.message) return;
  const idMsg = msg.key?.id || '';
  if (idMsg && processadas.has(idMsg)) return;
  if (idMsg) {
    processadas.set(idMsg, Date.now());
    setTimeout(() => processadas.delete(idMsg), 10 * 60 * 1000);
  }

  const fromMe = Boolean(msg.key?.fromMe);
  const jid = msg.key?.remoteJid || '';
  const telefoneBruto = limparTelefone(jid);
  const contatoAtual = await obterContato(telefoneBruto);
  const texto = extrairTextoMensagem(msg.message);
  const comprovante = detectarComprovante(msg, texto);
  const qtd = detectarQuantidade(texto);
  const interessado = detectarInteresse(texto) || Boolean(qtd);

  ultimaMensagem = {
    de: jid,
    telefone: telefoneBruto,
    mensagem: texto || '[mídia]',
    tipo: comprovante ? 'comprovante/midia' : 'texto',
    interessado,
    quantidade: qtd,
    comprovante,
    data: agoraIso(),
    horario: dataHumana(agoraIso())
  };

  if (fromMe) {
    if (detectarPdfBilheteFinal(msg)) {
      await salvarContato({ telefone: telefoneBruto, status: 'finalizado', ultima_mensagem: '[PDF real dos bilhetes enviado]', finalizado: true });
      await enviarTextoDestino(jid, agradecimentoFinal());
    }
    return;
  }

  await salvarResposta({ telefone: telefoneBruto, mensagem: texto || '[mídia/comprovante]', interessado });

  if (contatoAtual?.status === 'aguardando_dados' && texto) {
    const dados = extrairDadosCliente(texto);
    if (!dados.telefoneOk) {
      await enviarTextoDestino(jid, telefoneIncorreto());
      await salvarContato({ telefone: telefoneBruto, status: 'aguardando_dados', ultima_mensagem: texto, interessado: true, comprovante: true });
      return;
    }
    await salvarContato({ telefone: telefoneBruto, nome: dados.nome || contatoAtual.nome, status: 'aguardando_finalizacao', ultima_mensagem: texto, interessado: true, comprovante: true, lista: 'aguardando_finalizacao' });
    await enviarTextoDestino(jid, dadosRecebidos());
    return;
  }

  if (comprovante) {
    await salvarContato({ telefone: telefoneBruto, status: 'aguardando_dados', ultima_mensagem: texto || '[comprovante]', interessado: true, comprovante: true, lista: 'aguardando_dados' });
    await enviarTextoDestino(jid, respostaComprovante());
    return;
  }

  if (qtd) {
    const pix = await gerarPixPedido(qtd, telefoneBruto);
    await salvarContato({ telefone: telefoneBruto, status: 'aguardando_pagamento', ultima_mensagem: texto, interessado: true, quantidade: qtd, lista: 'aguardando_pagamento' });
    await enviarTextoDestino(jid, respostaQuantidade(qtd, pix.texto));
    return;
  }

  if (interessado) {
    await salvarContato({ telefone: telefoneBruto, status: 'interessado', ultima_mensagem: texto, interessado: true, lista: 'interessado' });
    await enviarTextoDestino(jid, perguntaQuantidade());
  } else {
    await salvarContato({ telefone: telefoneBruto, status: 'respondeu', ultima_mensagem: texto, interessado: false, lista: 'respondeu' });
    const chave = `fora-${telefoneBruto}`;
    const agora = Date.now();
    if (!cooldown.has(chave) || agora - cooldown.get(chave) > 10 * 60 * 1000) {
      cooldown.set(chave, agora);
      await enviarTextoDestino(jid, mensagemForaDoFluxo());
    }
  }
}
iniciarWhatsApp();

app.get('/status', (req, res) => res.json({
  online: true,
  sistema: CONFIG.sistema,
  versao: CONFIG.versao,
  conectado,
  numeroConectado,
  temQr: Boolean(qrDataUrl),
  iniciando,
  auth: SUPABASE_URL && SUPABASE_KEY ? 'supabase' : 'memoria/local',
  pagbank: PAGBANK_TOKEN ? 'token_configurado' : 'pendente',
  ultimaMensagemRecebida: ultimaMensagem,
  campanhaProgresso
}));
app.get('/qr', (req, res) => res.json({ conectado, numeroConectado, qr: qrDataUrl, iniciando }));
app.post('/api/novo-qr', async (req, res) => {
  try {
    await authClearAll();
    await reiniciarSocket();
    res.json({ sucesso: true, mensagem: 'Sessão apagada. Aguarde alguns segundos e clique em Atualizar status para aparecer o QR.' });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});
app.post('/api/pairing-code', async (req, res) => {
  res.status(400).json({ sucesso: false, erro: 'Conexão por código desativada nesta versão. Use QR Code, que é o método estável.' });
});
app.get('/api/contatos', async (req, res) => {
  const todos = await listarContatos();
  const q = textoNormalizado(req.query.q || '');
  const status = String(req.query.status || 'todos');
  const lista = String(req.query.lista || 'todas');
  let filtrados = todos;
  if (q) filtrados = filtrados.filter(c => textoNormalizado(`${c.nome || ''} ${c.telefone || ''} ${c.ultima_mensagem || ''}`).includes(q));
  if (status !== 'todos') filtrados = filtrados.filter(c => (c.status || 'novo') === status);
  if (lista !== 'todas') filtrados = filtrados.filter(c => (c.lista || c.status || 'novo') === lista);
  res.json({ sucesso: true, contatos: filtrados, total: todos.length });
});
app.post('/api/contatos', async (req, res) => {
  const valid = validarTelefoneBR(req.body.telefone);
  if (!valid.ok) return res.status(400).json({ sucesso: false, erro: valid.erro });
  await salvarContato({ telefone: valid.telefone, nome: req.body.nome, status: req.body.status || 'novo', lista: req.body.lista || req.body.status || 'novo' });
  res.json({ sucesso: true, telefone: valid.telefone });
});
app.post('/api/enviar', async (req, res) => {
  try {
    const envio = await enviarTextoDestino(req.body.telefone, req.body.mensagem);
    res.json({ sucesso: true, envio });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});
app.post('/api/enviar-midia', async (req, res) => {
  try {
    const envio = await enviarMidiaDestino(req.body.telefone, req.body.arquivoBase64, req.body.nomeArquivo, req.body.mimetype, req.body.legenda || '');
    res.json({ sucesso: true, envio });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});
app.post('/api/enviar-midia-lote', async (req, res) => {
  try {
    const tels = Array.isArray(req.body.telefones) ? req.body.telefones : [];
    const limite = Math.min(Number(req.body.limite || tels.length), tels.length);
    const intervalo = Math.max(1500, Number(req.body.intervalo || CONFIG.intervaloPadrao));
    let enviados = 0, erros = 0;
    for (const tel of tels.slice(0, limite)) {
      try {
        await enviarMidiaDestino(tel, req.body.arquivoBase64, req.body.nomeArquivo, req.body.mimetype, req.body.legenda || '');
        enviados++;
        await delay(intervalo);
      } catch { erros++; }
    }
    res.json({ sucesso: true, enviados, erros });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});
app.post('/api/acao-cliente', async (req, res) => {
  try {
    const { telefone, acao } = req.body;
    if (acao === 'pix') await enviarTextoDestino(telefone, perguntaQuantidade());
    if (acao === 'dados') await enviarTextoDestino(telefone, respostaComprovante());
    if (acao === 'finalizar') {
      await salvarContato({ telefone, status: 'finalizado', ultima_mensagem: '[finalizado pelo atendente]', finalizado: true, lista: 'finalizado' });
      await enviarTextoDestino(telefone, agradecimentoFinal());
    }
    res.json({ sucesso: true });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});
app.post('/api/campanhas-salvas', (req, res) => {
  const item = { id: Date.now(), nome: req.body.nome || 'Campanha', mensagem: req.body.mensagem || '', criado_em: agoraIso(), horario: dataHumana(agoraIso()) };
  memoria.campanhasSalvas.unshift(item);
  memoria.campanhasSalvas = memoria.campanhasSalvas.slice(0, 30);
  res.json({ sucesso: true, campanha: item, campanhas: memoria.campanhasSalvas });
});
app.get('/api/campanhas-salvas', (req, res) => res.json({ sucesso: true, campanhas: memoria.campanhasSalvas }));
app.post('/api/campanha', async (req, res) => {
  if (campanhaRodando) return res.status(409).json({ sucesso: false, erro: 'Campanha já está rodando' });

  const contatos = await listarContatos();
  const selecionados = Array.isArray(req.body.selecionados) ? req.body.selecionados.map(limparTelefone) : [];
  const filtro = req.body.filtro || 'todos';
  const busca = textoNormalizado(req.body.busca || '');
  const mensagem = String(req.body.mensagem || '').trim() || '🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.';
  const limite = Number(req.body.limite || CONFIG.limitePadrao);
  const intervalo = Math.max(1200, Number(req.body.intervalo || CONFIG.intervaloPadrao));
  const agendarPara = String(req.body.agendarPara || '').trim();
  const validadeMinutos = Number(req.body.validadeMinutos || CONFIG.validadeCampanhaMinutos);

  let alvo = contatos;
  if (selecionados.length) alvo = contatos.filter(c => selecionados.includes(limparTelefone(c.telefone)));
  else if (filtro !== 'todos') alvo = contatos.filter(c => (c.status || 'novo') === filtro);
  if (busca) alvo = alvo.filter(c => textoNormalizado(`${c.nome||''} ${c.telefone||''} ${c.ultima_mensagem||''}`).includes(busca));
  alvo = alvo.slice(0, limite);

  campanhaRodando = !agendarPara;
  const registro = {
    id: Date.now(),
    nome: req.body.nome || 'Campanha',
    total: alvo.length,
    enviados: 0,
    erros: 0,
    expirados: 0,
    respostas: 0,
    compras: 0,
    inicio: agoraIso(),
    agendada_para: agendarPara || null,
    fim: null,
    status: agendarPara ? 'agendada' : 'rodando'
  };
  memoria.campanhas.unshift(registro);
  memoria.campanhas = memoria.campanhas.slice(0, 30);
  campanhaProgresso = { id: registro.id, total: alvo.length, enviados: 0, erros: 0, expirados: 0, respostas: 0, compras: 0, status: registro.status, inicio: registro.inicio, fim: null };
  res.json({ sucesso: true, mensagem: agendarPara ? 'Campanha agendada' : 'Campanha iniciada', total: alvo.length });

  async function executar() {
    campanhaRodando = true;
    campanhaProgresso.status = 'rodando';
    registro.status = 'rodando';
    const limiteHorario = Date.now() + validadeMinutos * 60 * 1000;
    for (const c of alvo) {
      if (Date.now() > limiteHorario) { campanhaProgresso.expirados++; registro.expirados++; continue; }
      try {
        await enviarTextoDestino(c.telefone, mensagem);
        campanhaProgresso.enviados++; registro.enviados++;
        await salvarContato({ telefone: c.telefone, status: c.status || 'novo', lista: c.lista || c.status || 'novo', ultima_mensagem: mensagem });
        await delay(intervalo);
      } catch { campanhaProgresso.erros++; registro.erros++; }
    }
    campanhaProgresso.status = 'finalizada';
    campanhaProgresso.fim = agoraIso();
    registro.status = 'finalizada';
    registro.fim = campanhaProgresso.fim;
    campanhaRodando = false;
  }
  setTimeout(executar, agendarPara ? Math.max(0, new Date(agendarPara).getTime() - Date.now()) : 0);
});
app.get('/api/campanhas', (req, res) => res.json({ sucesso: true, campanhas: memoria.campanhas.map(c => ({...c, horario: dataHumana(c.inicio), horario_fim: dataHumana(c.fim), horario_agendada: dataHumana(c.agendada_para) })), progresso: campanhaProgresso }));

function html() {
return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reino Zap PRO</title><style>
*{box-sizing:border-box}body{margin:0;background:#071327;color:#fff;font-family:Arial,sans-serif}header{background:#172554;padding:22px 12px;text-align:center;border-bottom:4px solid #3b63ff}h1{font-size:28px;margin:0}main{max-width:1180px;margin:auto;padding:12px}.nav{display:flex;gap:8px;overflow-x:auto;margin:10px 0;position:sticky;top:0;background:#071327;z-index:9;padding:8px 0}.nav button{min-width:max-content;background:#253760}.card{background:#151c31;border:1px solid #33415f;border-radius:18px;padding:14px;margin-bottom:14px}h2{color:#aac7ff;font-size:21px;margin:0 0 12px}input,textarea,select,button{width:100%;padding:13px;border-radius:12px;border:1px solid #40506e;background:#0a1426;color:#fff;font-size:15px;margin:6px 0}textarea{min-height:110px}button{border:0;background:#4f6bed;font-weight:bold;cursor:pointer}.danger{background:#d12d37}.orange{background:#e96f23}.green{background:#22a852}.gray{background:#475569}.box{background:#090e1e;border-radius:12px;padding:12px;margin-top:8px;white-space:pre-wrap;overflow:auto}.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.item{background:#0a1426;border:1px solid #3a4a68;border-radius:14px;padding:11px;margin-top:8px}.tag{display:inline-block;background:#3d4d89;padding:5px 9px;border-radius:99px;font-size:12px;margin:2px}.ok{color:#9dff91;font-weight:bold}.warn{color:#ffe17a}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.bar{height:14px;background:#071024;border-radius:99px;overflow:hidden;border:1px solid #304160}.fill{height:100%;background:#4f6bed;width:0%}.alerta{border-color:#ffcc00;box-shadow:0 0 0 2px rgba(255,204,0,.15)}.small{font-size:13px;color:#b8c6e6}.code{font-size:30px;text-align:center;letter-spacing:4px;font-weight:bold;color:#9dff91}.muted{color:#aab7d7;font-size:12px}.btnline{display:flex;gap:6px}.btnline button{font-size:12px;padding:9px}.hide{display:none}@media(min-width:900px){.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.wide{grid-column:1/3}.kpi{grid-template-columns:repeat(4,1fr)}} </style></head><body><header><h1>👑 Reino Zap PRO</h1><p>Painel operacional V17.7</p></header><main><div class="nav"><button data-scroll="dash">Dashboard</button><button data-scroll="camp">Campanhas</button><button data-scroll="clientes">Clientes</button><button data-scroll="midia">Imagem/PDF</button><button data-scroll="atendimento">Atendimento</button></div><div class="grid">
<section class="card" id="dash"><h2>1. WhatsApp</h2><div id="status">Carregando...</div><button id="btnAtualizar">Atualizar status</button><button class="gray" id="btnNovoQr">Gerar novo QR / Reconectar</button><div id="qr"></div><div class="small">Conexão por código foi removida da tela porque falhou nos testes. Use QR Code.</div></section>
<section class="card"><h2>2. Envio rápido</h2><input id="telRapido" inputmode="tel" placeholder="DDD + telefone. Ex: 88994943632"><textarea id="msgRapida">Teste Reino Zap ✅</textarea><button class="orange" id="btnEnvioRapido">Enviar mensagem</button><div id="retRapido" class="box"></div></section>
<section class="card wide" id="camp"><h2>3. Campanhas profissionais</h2><select id="campPronta"><option value="">Carregar campanha salva/pronta</option><option value="🎟️ HOJE TEM REINO DA SORTE!\\n\\nBilhete por apenas R$ 2,00.\\n\\nResponda com a quantidade que deseja comprar.">Hoje tem Reino</option><option value="🍀 Bora participar do sorteio de hoje?\\n\\n🎟️ Bilhete R$ 2,00\\nResponda só com a quantidade. Ex: 2, 5 ou 10.">Bora participar</option></select><div class="row"><input id="nomeCamp" placeholder="Nome da campanha"><button class="green" id="btnSalvarCamp">Salvar campanha</button></div><textarea id="msgCamp">🎟️ HOJE TEM REINO DA SORTE!\\n\\nBilhete por apenas R$ 2,00.\\n\\nResponda com a quantidade que deseja comprar.</textarea><div class="row"><input id="limite" value="20" placeholder="Quantidade máxima de clientes"><input id="intervalo" value="3000" placeholder="Intervalo entre envios em ms"></div><div class="row"><select id="filtro"><option value="todos">Enviar para todos</option><option value="novo">Novos</option><option value="respondeu">Responderam</option><option value="interessado">Interessados</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="aguardando_dados">Aguardando dados</option><option value="aguardando_finalizacao">Aguardando finalização</option><option value="finalizado">Compradores finalizados</option></select><input id="buscaCamp" placeholder="Buscar dentro da campanha"></div><div class="row"><input id="agendar" type="datetime-local"><input id="validade" value="60" placeholder="Validade da fila em minutos"></div><button class="danger" id="btnCampanha">Enviar / Agendar campanha</button><div class="box"><b>Progresso real</b><div class="bar"><div id="fill" class="fill"></div></div><div id="prog">Parado</div></div><div id="retCamp" class="box"></div></section>
<section class="card"><h2>4. Adicionar contato</h2><input id="nome" placeholder="Nome"><input id="telefone" inputmode="tel" placeholder="DDD + telefone. Ex: 88994943632"><select id="statusContato"><option value="novo">Novo</option><option value="interessado">Interessado</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="finalizado">Comprador finalizado</option></select><button id="btnAddContato">Salvar contato</button><div id="retContato" class="box"></div></section>
<section class="card" id="midia"><h2>5. Enviar imagem/PDF</h2><input id="midiaTel" placeholder="Telefone único ou deixe vazio para seleção"><input id="midiaFile" type="file" accept="image/*,.pdf,application/pdf"><textarea id="midiaLegenda" placeholder="Legenda opcional"></textarea><div class="row"><input id="midiaLimite" value="20" placeholder="Limite lote"><input id="midiaIntervalo" value="3000" placeholder="Intervalo ms"></div><button class="green" id="btnMidiaUm">Enviar para telefone</button><button class="orange" id="btnMidiaSel">Enviar para selecionados</button><div id="retMidia" class="box"></div></section>
<section class="card"><h2>6. Fluxo automático</h2><div class="box">Cliente recebe campanha → responde quantidade → sistema envia Pix fixo/estrutura PagBank → cliente envia comprovante com texto claro → sistema pede NOME e TELEFONE → telefone é validado → atendimento humano toca alerta → atendente envia PDF real dos bilhetes → pedido finalizado.</div></section>
<section class="card wide"><h2>7. Última mensagem</h2><div id="ultima" class="box">-</div></section>
<section class="card wide"><h2>8. Histórico de campanhas</h2><div id="historicoCamp"></div></section>
<section class="card wide" id="clientes"><h2>9. Clientes / Contatos reais</h2><div class="row"><input id="buscaCliente" placeholder="Buscar nome ou telefone"><select id="filtroCliente"><option value="todos">Todos status</option><option value="novo">Novos</option><option value="respondeu">Responderam</option><option value="interessado">Interessados</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="aguardando_dados">Aguardando dados</option><option value="aguardando_finalizacao">Aguardando finalização</option><option value="finalizado">Finalizados/compradores</option></select></div><button id="btnAtualizarClientes">Atualizar / Buscar clientes</button><div class="row"><button id="btnSelTodos">Selecionar todos visíveis</button><button id="btnLimparSel">Limpar seleção</button></div><div class="kpi" id="kpis"></div><div id="lista"></div></section>
<section class="card wide" id="atendimento"><h2>10. Atendimento humanizado</h2><p>O alerta toca somente quando o cliente enviou comprovante e depois enviou nome/telefone válido.</p><div id="manual"></div></section>
</div></main><script>
window.onerror=function(msg,src,line,col,err){try{document.getElementById('status').innerHTML='Erro no painel: '+msg+' linha '+line;}catch(e){}};
var contatos=[],selecionados=new Set(),ultimoManual=0,travando=false;
function el(id){return document.getElementById(id)} function j(x){return JSON.stringify(x,null,2)}
async function api(u,o){var r=await fetch(u,o);var data=await r.json().catch(function(){return{sucesso:false,erro:'Resposta inválida'}});if(!r.ok&&!data.erro)data.erro='Erro HTTP '+r.status;return data}
function lock(btn,txt){if(!btn)return function(){};var old=btn.innerText;btn.disabled=true;btn.innerText=txt||'Aguarde...';return function(){btn.disabled=false;btn.innerText=old}}
function bip(){try{var a=new AudioContext(),o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.08;o.start();setTimeout(function(){o.stop();a.close()},350)}catch(e){}}
function atualizaProgresso(p){p=p||{};var total=p.total||0,enviados=p.enviados||0,pct=total?Math.round(enviados/total*100):0;el('fill').style.width=pct+'%';el('prog').innerText=(p.status||'parado')+' • enviados '+enviados+'/'+total+' • '+pct+'% • erros: '+(p.erros||0)+' • expirados: '+(p.expirados||0)}
async function atualizar(){try{var s=await api('/status');el('status').innerHTML=s.conectado?'<p class="ok">WhatsApp conectado ✅<br>'+s.numeroConectado+'</p><small>Auth: '+s.auth+' • PagBank: '+s.pagbank+' • '+s.versao+'</small>':'<p class="warn">WhatsApp desconectado</p><small>Clique em Atualizar. Se não aparecer QR, use Gerar novo QR.</small>';el('ultima').innerText=j(s.ultimaMensagemRecebida||'-');var q=await api('/qr');el('qr').innerHTML=q.qr?'<img src="'+q.qr+'" style="width:100%;max-width:300px;background:white;padding:8px">':'Sem QR no momento.';atualizaProgresso(s.campanhaProgresso||{});await carregarCampanhas();await carregarClientes(false)}catch(e){el('status').innerHTML='Erro ao atualizar: '+e.message}}
async function novoQr(){if(!confirm('Isso apaga a sessão atual e gera novo QR. Continuar?'))return;var done=lock(el('btnNovoQr'),'Gerando QR...');var r=await api('/api/novo-qr',{method:'POST'});done();alert(r.mensagem||r.erro);setTimeout(atualizar,3500)}
async function enviarRapido(){var done=lock(el('btnEnvioRapido'),'Enviando...');var r=await api('/api/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:el('telRapido').value,mensagem:el('msgRapida').value})});done();el('retRapido').innerText=j(r)}
async function addContato(){var done=lock(el('btnAddContato'),'Salvando...');var r=await api('/api/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:el('nome').value,telefone:el('telefone').value,status:el('statusContato').value,lista:el('statusContato').value})});done();el('retContato').innerText=j(r);carregarClientes()}
function usarCampanha(){if(el('campPronta').value)el('msgCamp').value=el('campPronta').value.replaceAll('\\\\n',String.fromCharCode(10))}
async function salvarCampanhaLocal(){if(!el('nomeCamp').value.trim())return alert('Digite o nome da campanha');var r=await api('/api/campanhas-salvas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:el('nomeCamp').value,mensagem:el('msgCamp').value})});await carregarCampanhasSalvas();alert(r.sucesso?'Campanha salva':'Erro: '+r.erro)}
async function carregarCampanhasSalvas(){var r=await api('/api/campanhas-salvas');var sel=el('campPronta');var atual=sel.value;sel.innerHTML='<option value="">Carregar campanha salva/pronta</option><option value="🎟️ HOJE TEM REINO DA SORTE!\\\\n\\\\nBilhete por apenas R$ 2,00.\\\\n\\\\nResponda com a quantidade que deseja comprar.">Hoje tem Reino</option><option value="🍀 Bora participar do sorteio de hoje?\\\\n\\\\n🎟️ Bilhete R$ 2,00\\\\nResponda só com a quantidade. Ex: 2, 5 ou 10.">Bora participar</option>'+(r.campanhas||[]).map(function(c){return '<option value="'+String(c.mensagem).replaceAll('"','&quot;')+'">'+c.nome+'</option>'}).join('');sel.value=atual}
async function campanha(){var done=lock(el('btnCampanha'),'Processando...');var r=await api('/api/campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:el('nomeCamp').value||'Campanha',mensagem:el('msgCamp').value,limite:el('limite').value,intervalo:el('intervalo').value,filtro:el('filtro').value,busca:el('buscaCamp').value,agendarPara:el('agendar').value,validadeMinutos:el('validade').value,selecionados:Array.from(selecionados)})});done();el('retCamp').innerText=j(r)}
async function carregarCampanhas(){var r=await api('/api/campanhas');var arr=r.campanhas||[];el('historicoCamp').innerHTML=arr.map(function(c){return'<div class="item"><b>'+c.nome+'</b><br><span class="tag">'+c.status+'</span><br>Início: '+(c.horario||'-')+'<br>Agendada: '+(c.horario_agendada||'-')+'<br>Fim: '+(c.horario_fim||'-')+'<br>Enviados: '+c.enviados+'/'+c.total+'<br>Erros: '+c.erros+' • Expirados: '+(c.expirados||0)+'</div>'}).join('')||'<div class="item">Nenhuma campanha ainda</div>';atualizaProgresso(r.progresso||{})}
async function carregarClientes(scroll){var q=encodeURIComponent(el('buscaCliente')?.value||'');var st=encodeURIComponent(el('filtroCliente')?.value||'todos');var r=await api('/api/contatos?q='+q+'&status='+st);contatos=r.contatos||[];var sts=['novo','respondeu','interessado','aguardando_pagamento','aguardando_dados','aguardando_finalizacao','finalizado'];el('kpis').innerHTML=sts.map(function(s){return'<div class="item"><b>'+contatos.filter(function(c){return(c.status||'novo')===s}).length+'</b><br><span class="tag">'+s+'</span></div>'}).join('');el('lista').innerHTML=contatos.map(function(c){return cardCliente(c,false)}).join('')||'<div class="item">Nenhum contato salvo</div>';var man=contatos.filter(function(c){return c.status==='aguardando_finalizacao'});el('manual').innerHTML=man.map(function(c){return cardCliente(c,true)}).join('')||'<div class="item">Nenhum atendimento manual pendente</div>';if(man.length>ultimoManual)bip();ultimoManual=man.length}
function cardCliente(c,manual){var tel=c.telefone||'',chk=selecionados.has(tel)?'checked':'',cls=manual?'item alerta':'item';return'<div class="'+cls+'"><label><input style="width:auto" type="checkbox" data-sel="'+tel+'" '+chk+'> <b>'+(c.nome||'Sem nome')+'</b></label><br>'+tel+'<br><span class="tag">'+(c.status||'novo')+'</span> <span class="muted">'+(c.horario||'')+'</span><br>Última: '+(c.ultima_mensagem||'-')+'<div class="btnline"><button data-acao="pix" data-tel="'+tel+'">Pix</button><button data-acao="dados" data-tel="'+tel+'">Dados</button><button class="green" data-acao="finalizar" data-tel="'+tel+'">Finalizar</button></div></div>'}
function selecionarVisiveis(){contatos.forEach(function(c){selecionados.add(c.telefone)});carregarClientes()}function limparSelecao(){selecionados.clear();carregarClientes()}
async function acaoCliente(tel,acao){var r=await api('/api/acao-cliente',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:tel,acao:acao})});alert(r.sucesso?'Ação enviada':'Erro: '+r.erro);carregarClientes()}
function lerArquivo(){return new Promise(function(resolve,reject){var f=el('midiaFile').files[0];if(!f)return reject(new Error('Escolha uma imagem ou PDF'));var rd=new FileReader();rd.onload=function(){resolve({arquivoBase64:rd.result,nomeArquivo:f.name,mimetype:f.type||'application/pdf'})};rd.onerror=function(){reject(new Error('Falha ao ler arquivo'))};rd.readAsDataURL(f)})}
async function enviarMidiaUm(){try{var a=await lerArquivo();var done=lock(el('btnMidiaUm'),'Enviando...');var r=await api('/api/enviar-midia',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign(a,{telefone:el('midiaTel').value,legenda:el('midiaLegenda').value}))});done();el('retMidia').innerText=j(r)}catch(e){el('retMidia').innerText=e.message}}
async function enviarMidiaSel(){try{if(!selecionados.size)return alert('Selecione clientes primeiro');var a=await lerArquivo();var done=lock(el('btnMidiaSel'),'Enviando lote...');var r=await api('/api/enviar-midia-lote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign(a,{telefones:Array.from(selecionados),legenda:el('midiaLegenda').value,limite:el('midiaLimite').value,intervalo:el('midiaIntervalo').value}))});done();el('retMidia').innerText=j(r)}catch(e){el('retMidia').innerText=e.message}}
document.addEventListener('click',function(ev){var t=ev.target;if(t.dataset.scroll)document.getElementById(t.dataset.scroll).scrollIntoView({behavior:'smooth'});if(t.id==='btnAtualizar')atualizar();if(t.id==='btnNovoQr')novoQr();if(t.id==='btnEnvioRapido')enviarRapido();if(t.id==='btnSalvarCamp')salvarCampanhaLocal();if(t.id==='btnCampanha')campanha();if(t.id==='btnAddContato')addContato();if(t.id==='btnAtualizarClientes')carregarClientes(true);if(t.id==='btnSelTodos')selecionarVisiveis();if(t.id==='btnLimparSel')limparSelecao();if(t.id==='btnMidiaUm')enviarMidiaUm();if(t.id==='btnMidiaSel')enviarMidiaSel();if(t.dataset.acao)acaoCliente(t.dataset.tel,t.dataset.acao)})
document.addEventListener('change',function(ev){var t=ev.target;if(t.id==='campPronta')usarCampanha();if(t.dataset.sel){if(t.checked)selecionados.add(t.dataset.sel);else selecionados.delete(t.dataset.sel)}})
document.addEventListener('input',function(ev){if(ev.target.id==='buscaCliente'||ev.target.id==='filtroCliente'){clearTimeout(window._busca);window._busca=setTimeout(function(){carregarClientes()},500)}})
setInterval(atualizar,15000);carregarCampanhasSalvas();atualizar();
</script></body></html>`;
}

app.get('/', (req, res) => res.redirect('/painel'));
app.get('/painel', (req, res) => res.send(html()));
app.listen(PORT, () => console.log('Reino Zap PRO V17.7 OPERACIONAL rodando na porta ' + PORT));
