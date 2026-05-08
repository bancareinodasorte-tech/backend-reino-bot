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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const CONFIG = {
  sistema: 'Reino Zap PRO',
  versao: '17.7.1 BOTOES_CORRIGIDOS',
  bilheteValor: 2,
  pixChave: '88994943632',
  pixNome: 'G. DA SILVA',
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
let campanhaProgresso = { total: 0, enviados: 0, erros: 0, expirados: 0, status: 'parado', inicio: null, fim: null };
const memoria = { contatos: new Map(), mensagens: [], campanhas: [], campanhasSalvas: [] };
const processadas = new Map();
const cooldown = new Map();
const travaEnvio = new Map();

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
function agoraISO() { return new Date().toISOString(); }
function horaHumana(iso) {
  if (!iso) return '-';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '-';
  const hoje = new Date();
  const ontem = new Date(); ontem.setDate(hoje.getDate() - 1);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const mesmoDia = d.toDateString() === hoje.toDateString();
  const diaOntem = d.toDateString() === ontem.toDateString();
  if (mesmoDia) return `Hoje ${hh}:${mm}`;
  if (diaOntem) return `Ontem ${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth()+1).padStart(2, '0')} — ${hh}:${mm}`;
}
function detectarInteresse(texto = '') {
  const t = textoNormalizado(texto); if (!t) return false;
  return ['quero','comprar','participar','bilhete','bilhetes','pix','valor','manda','sim','vou querer','tenho interesse','quanto','pode ser','ok'].some(p => t.includes(p));
}
function detectarQuantidade(texto = '') { const m = textoNormalizado(texto).match(/\b(\d{1,4})\b/); if (!m) return null; const n = Number(m[1]); return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null; }
function extrairTextoMensagem(message = {}) { return message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.documentMessage?.caption || message.videoMessage?.caption || ''; }
function detectarComprovante(msg, texto = '') {
  const m = msg?.message || {}; const t = textoNormalizado(texto);
  const temMidia = Boolean(m.imageMessage || m.documentMessage);
  const falaPagamento = ['paguei','pago','comprovante','enviei','transferi','pix feito','segue comprovante'].some(p => t.includes(p));
  if (temMidia && falaPagamento) return true;
  return Boolean(!temMidia && falaPagamento);
}
function detectarPdfDoAtendente(msg) {
  const doc = msg?.message?.documentMessage;
  const nome = textoNormalizado(doc?.fileName || '');
  const mime = textoNormalizado(doc?.mimetype || '');
  return Boolean(msg?.key?.fromMe && doc && mime.includes('pdf') && (nome.includes('bilhete') || nome.includes('reino') || nome.includes('sorte')));
}
function respostaQuantidade(qtd) { return `Perfeito! 🎟️\n\nVocê escolheu: ${qtd} bilhete${qtd > 1 ? 's' : ''}\n\n💰 Total: ${moeda(qtd * CONFIG.bilheteValor)}\n\n📲 Pagamento via Pix:\nChave: ${CONFIG.pixChave}\nNome: ${CONFIG.pixNome}\n\n⚠️ Envie o comprovante aqui para confirmar seu pedido.`; }
function perguntaQuantidade() { return `Perfeito! 🎟️\n\nQuantos bilhetes você deseja comprar?\nDigite apenas o número.\n\nExemplo: 1, 2, 5, 10...`; }
function respostaComprovante() { return `Recebido! ✅\n\n• Preencha os dados\nNOME:\nTELEFONE:\n\n⚠️ Aguarde o comprovante dos seus bilhetes`; }
function dadosRecebidos() { return `Dados recebidos ✅\n\nSeu pedido foi encaminhado para finalização.\nAguarde o comprovante dos seus bilhetes.`; }
function telefoneIncorreto() { return `O telefone informado parece estar incompleto ou incorreto.\n\nEnvie novamente assim:\nNOME: Seu nome\nTELEFONE: DDD + número\n\nExemplo:\nNOME: João Silva\nTELEFONE: 88994943632`; }
function mensagemForaDoFluxo() { return `Este CANAL é exclusivo para compras de bilhetes do Reino da Sorte 🎟️\n\n1. Para continuar a compra digite somente a quantidade de bilhetes:\n\n2) Para outros assuntos clique 👇:\n${CONFIG.suporteTexto}`; }
function agradecimentoFinal() { return `REINO DA SORTE AGRADECE SUA COMPRA\n\n🍀 Boa Sorte 🍀`; }
function extrairDadosCliente(texto = '') {
  const bruto = String(texto || '').trim();
  const telefoneMatch = bruto.match(/(?:telefone|tel|whats|whatsapp)?\D*((?:55)?\d{10,13})/i);
  const tel = telefoneMatch ? telefoneMatch[1] : '';
  const validacao = validarTelefoneBR(tel);
  let nome = bruto.replace(/telefone\s*:?.*/ig,'').replace(/tel\s*:?.*/ig,'').replace(/whats\s*:?.*/ig,'').replace(/whatsapp\s*:?.*/ig,'').replace(/\d{8,13}/g,'').replace(/nome\s*:?/ig,'').trim();
  nome = nome.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
  return { nome: nome.length >= 2 ? nome : '', telefone: validacao.telefone, telefoneOk: validacao.ok };
}
function base64Buffer(base64 = '') {
  const clean = String(base64).includes(',') ? String(base64).split(',').pop() : String(base64);
  return Buffer.from(clean, 'base64');
}

async function supabase(method, path, body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=merge-duplicates,return=representation' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { console.log('Supabase erro:', method, path, await r.text()); return null; }
  if (r.status === 204) return null; try { return await r.json(); } catch { return null; }
}
async function authRead(id) { const data = await supabase('GET', `zap_auth?select=value&id=eq.${encodeURIComponent(id)}&limit=1`); const row = Array.isArray(data) ? data[0] : null; return row ? JSON.parse(JSON.stringify(row.value), BufferJSON.reviver) : null; }
async function authWrite(id, value) { const safe = JSON.parse(JSON.stringify(value, BufferJSON.replacer)); await supabase('POST', 'zap_auth?on_conflict=id', { id, value: safe, updated_at: agoraISO() }); }
async function authDelete(id) { if (!SUPABASE_URL || !SUPABASE_KEY) return; await fetch(`${SUPABASE_URL}/rest/v1/zap_auth?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }); }
async function authClearAll() { if (!SUPABASE_URL || !SUPABASE_KEY) return; await fetch(`${SUPABASE_URL}/rest/v1/zap_auth?id=not.is.null`, { method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }); }
async function useSupabaseAuthState() {
  const creds = (await authRead('creds')) || initAuthCreds();
  return { state: { creds, keys: { get: async (type, ids) => { const data = {}; await Promise.all(ids.map(async id => { let value = await authRead(`${type}-${id}`); if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value); data[id] = value; })); return data; }, set: async data => { const tasks = []; for (const category of Object.keys(data)) for (const id of Object.keys(data[category])) { const value = data[category][id]; tasks.push(value ? authWrite(`${category}-${id}`, value) : authDelete(`${category}-${id}`)); } await Promise.all(tasks); } } }, saveCreds: () => authWrite('creds', creds) };
}

async function salvarContato({ telefone, nome = '', status = 'novo', ultima_mensagem = '', interessado = false, quantidade = null, comprovante = false }) {
  const valid = validarTelefoneBR(telefone); const tel = valid.ok ? valid.telefone : limparTelefone(telefone); if (!tel) return null;
  const atual = memoria.contatos.get(tel) || {};
  const contato = { telefone: tel, nome: nome || atual.nome || '', status: status || atual.status || 'novo', ultima_mensagem: ultima_mensagem || atual.ultima_mensagem || '', interessado: Boolean(interessado || atual.interessado), quantidade: quantidade || atual.quantidade || null, comprovante: Boolean(comprovante || atual.comprovante), atualizado_em: agoraISO(), atualizado_humano: horaHumana(agoraISO()) };
  memoria.contatos.set(tel, contato); await supabase('POST', 'contatos?on_conflict=telefone', contato); return contato;
}
async function salvarResposta({ telefone, mensagem, interessado = false }) { const tel = normalizarTelefoneBR(telefone) || limparTelefone(telefone); memoria.mensagens.unshift({ telefone: tel, mensagem, interessado, criado_em: agoraISO(), criado_humano: horaHumana(agoraISO()) }); memoria.mensagens = memoria.mensagens.slice(0, 200); await supabase('POST', 'respostas', { telefone: tel, mensagem, interessado }); if (interessado) await supabase('POST', 'interessados', { telefone: tel, origem: 'whatsapp' }); }
async function listarContatos() { const data = await supabase('GET', 'contatos?select=*&order=id.desc'); if (Array.isArray(data)) { data.forEach(c => memoria.contatos.set(c.telefone, c)); return data; } return Array.from(memoria.contatos.values()).reverse(); }
async function obterContato(telefone) { const tel = normalizarTelefoneBR(telefone) || limparTelefone(telefone); if (memoria.contatos.has(tel)) return memoria.contatos.get(tel); const data = await supabase('GET', `contatos?select=*&telefone=eq.${encodeURIComponent(tel)}&limit=1`); if (Array.isArray(data) && data[0]) { memoria.contatos.set(tel, data[0]); return data[0]; } return null; }
async function enviarTextoDestino(destino, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  const chave = `${limparTelefone(destino)}-${String(texto || '').slice(0, 60)}`;
  const agora = Date.now();
  if (travaEnvio.has(chave) && agora - travaEnvio.get(chave) < 2500) return { bloqueado: true, motivo: 'Envio duplicado bloqueado' };
  travaEnvio.set(chave, agora);
  let jidFinal = destino;
  if (!String(destino).includes('@')) { const valid = validarTelefoneBR(destino); if (!valid.ok) throw new Error(valid.erro); const jid = jidDoNumero(valid.telefone); const existe = await sock.onWhatsApp(jid); jidFinal = existe?.[0]?.jid || jid; }
  const resp = await sock.sendMessage(jidFinal, { text: texto });
  return { jid: jidFinal, resposta: resp };
}
async function enviarMidiaDestino(destino, arquivo) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  let jidFinal = destino;
  if (!String(destino).includes('@')) { const valid = validarTelefoneBR(destino); if (!valid.ok) throw new Error(valid.erro); const jid = jidDoNumero(valid.telefone); const existe = await sock.onWhatsApp(jid); jidFinal = existe?.[0]?.jid || jid; }
  const buffer = base64Buffer(arquivo.base64);
  const mimetype = arquivo.mimetype || 'application/octet-stream';
  const nome = arquivo.nome || 'arquivo';
  const legenda = arquivo.legenda || '';
  if (mimetype.startsWith('image/')) return await sock.sendMessage(jidFinal, { image: buffer, caption: legenda, mimetype });
  return await sock.sendMessage(jidFinal, { document: buffer, fileName: nome, mimetype, caption: legenda });
}

async function reiniciarSocket() { try { sock?.ws?.close?.(); } catch {} sock = null; conectado = false; qrDataUrl = ''; numeroConectado = ''; iniciando = false; setTimeout(iniciarWhatsApp, 1000); }
async function iniciarWhatsApp() {
  if (iniciando || sock) return; iniciando = true;
  try {
    const { state, saveCreds } = await useSupabaseAuthState(); const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: ['Reino Zap PRO', 'Chrome', '17.7.1'] }); iniciando = false;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => { const { connection, lastDisconnect, qr } = update; if (qr) { qrDataUrl = await QRCode.toDataURL(qr); conectado = false; } if (connection === 'open') { conectado = true; qrDataUrl = ''; numeroConectado = sock.user?.id || ''; console.log('WhatsApp conectado:', numeroConectado); } if (connection === 'close') { conectado = false; sock = null; qrDataUrl = ''; const reason = lastDisconnect?.error?.output?.statusCode; console.log('WhatsApp desconectado:', reason); if (reason === DisconnectReason.loggedOut || reason === 401) { await authClearAll(); setTimeout(iniciarWhatsApp, 2500); } else { setTimeout(iniciarWhatsApp, 3000); } } });
    sock.ev.on('messages.upsert', async ({ messages }) => { for (const msg of messages || []) { try { await processarMensagem(msg); } catch(e) { console.log('Erro processando mensagem:', e.message); } } });
  } catch (e) { sock = null; iniciando = false; console.log('Erro ao iniciar WhatsApp:', e.message); setTimeout(iniciarWhatsApp, 5000); }
}
async function processarMensagem(msg) {
  if (!msg.message) return; const idMsg = msg.key?.id || ''; if (idMsg && processadas.has(idMsg)) return; if (idMsg) { processadas.set(idMsg, Date.now()); setTimeout(() => processadas.delete(idMsg), 10 * 60 * 1000); }
  const fromMe = Boolean(msg.key?.fromMe); const jid = msg.key?.remoteJid || ''; const telefoneBruto = limparTelefone(jid); const contatoAtual = await obterContato(telefoneBruto); const texto = extrairTextoMensagem(msg.message); const comprovante = detectarComprovante(msg, texto); const qtd = detectarQuantidade(texto); const interessado = detectarInteresse(texto) || Boolean(qtd);
  ultimaMensagem = { de: jid, telefone: telefoneBruto, mensagem: texto || '[mídia]', tipo: comprovante ? 'comprovante/midia' : 'texto', interessado, quantidade: qtd, comprovante, data: agoraISO(), dataHumana: horaHumana(agoraISO()) };
  if (fromMe) { if (detectarPdfDoAtendente(msg)) { await salvarContato({ telefone: telefoneBruto, status: 'finalizado', ultima_mensagem: '[PDF bilhete enviado pelo atendente]' }); await enviarTextoDestino(jid, agradecimentoFinal()); } return; }
  await salvarResposta({ telefone: telefoneBruto, mensagem: texto || '[mídia/comprovante]', interessado });
  if (contatoAtual?.status === 'aguardando_dados' && texto) { const dados = extrairDadosCliente(texto); if (!dados.telefoneOk) { await enviarTextoDestino(jid, telefoneIncorreto()); await salvarContato({ telefone: telefoneBruto, status: 'aguardando_dados', ultima_mensagem: texto, interessado: true, comprovante: true }); return; } await salvarContato({ telefone: telefoneBruto, nome: dados.nome || contatoAtual.nome, status: 'aguardando_finalizacao', ultima_mensagem: texto, interessado: true, comprovante: true }); await enviarTextoDestino(jid, dadosRecebidos()); return; }
  if (comprovante) { await salvarContato({ telefone: telefoneBruto, status: 'aguardando_dados', ultima_mensagem: texto || '[comprovante]', interessado: true, comprovante: true }); await enviarTextoDestino(jid, respostaComprovante()); return; }
  if (qtd) { await salvarContato({ telefone: telefoneBruto, status: 'aguardando_pagamento', ultima_mensagem: texto, interessado: true, quantidade: qtd }); await enviarTextoDestino(jid, respostaQuantidade(qtd)); return; }
  if (interessado) { await salvarContato({ telefone: telefoneBruto, status: 'interessado', ultima_mensagem: texto, interessado: true }); await enviarTextoDestino(jid, perguntaQuantidade()); } else { await salvarContato({ telefone: telefoneBruto, status: 'respondeu', ultima_mensagem: texto, interessado: false }); const chave = `fora-${telefoneBruto}`; const agora = Date.now(); if (!cooldown.has(chave) || agora - cooldown.get(chave) > 10 * 60 * 1000) { cooldown.set(chave, agora); await enviarTextoDestino(jid, mensagemForaDoFluxo()); } }
}
iniciarWhatsApp();

app.get('/status', (req, res) => res.json({ online: true, sistema: CONFIG.sistema, versao: CONFIG.versao, conectado, numeroConectado, temQr: Boolean(qrDataUrl), iniciando, auth: SUPABASE_URL && SUPABASE_KEY ? 'supabase' : 'memoria/local', ultimaMensagemRecebida: ultimaMensagem, campanhaProgresso }));
app.get('/qr', (req, res) => res.json({ conectado, numeroConectado, qr: qrDataUrl, iniciando }));
app.post('/api/novo-qr', async (req, res) => { try { await authClearAll(); await reiniciarSocket(); res.json({ sucesso: true, mensagem: 'Sessão apagada. Aguarde alguns segundos e atualize para aparecer o QR.' }); } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); } });
app.post('/api/pairing-code', async (req, res) => res.status(400).json({ sucesso: false, erro: 'Conexão por código falhou nos testes. Use QR Code.' }));
app.get('/api/contatos', async (req, res) => res.json({ sucesso: true, contatos: await listarContatos() }));
app.post('/api/contatos', async (req, res) => { const valid = validarTelefoneBR(req.body.telefone); if (!valid.ok) return res.status(400).json({ sucesso: false, erro: valid.erro }); await salvarContato({ telefone: valid.telefone, nome: req.body.nome, status: req.body.status || 'novo' }); res.json({ sucesso: true, telefone: valid.telefone }); });
app.post('/api/enviar', async (req, res) => { try { const envio = await enviarTextoDestino(req.body.telefone, req.body.mensagem); res.json({ sucesso: true, envio }); } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); } });
app.post('/api/enviar-midia', async (req, res) => { try { const telefones = Array.isArray(req.body.telefones) ? req.body.telefones : [req.body.telefone]; const arquivo = req.body.arquivo || {}; const enviados = []; const erros = []; for (const tel of telefones.filter(Boolean)) { try { await enviarMidiaDestino(tel, arquivo); enviados.push(tel); await delay(Math.max(1200, Number(req.body.intervalo || 3000))); } catch(e) { erros.push({ telefone: tel, erro: e.message }); } } res.json({ sucesso: erros.length === 0, enviados, erros }); } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); } });
app.post('/api/acao-cliente', async (req, res) => { try { const { telefone, acao } = req.body; if (acao === 'pix') await enviarTextoDestino(telefone, perguntaQuantidade()); if (acao === 'dados') await enviarTextoDestino(telefone, respostaComprovante()); if (acao === 'finalizar') { await salvarContato({ telefone, status: 'finalizado', ultima_mensagem: '[finalizado pelo atendente]' }); await enviarTextoDestino(telefone, agradecimentoFinal()); } res.json({ sucesso: true }); } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); } });
app.post('/api/campanha-salvar', (req, res) => { const c = { id: Date.now(), nome: String(req.body.nome || 'Campanha').trim(), mensagem: String(req.body.mensagem || '').trim(), criado_em: agoraISO(), criado_humano: horaHumana(agoraISO()) }; memoria.campanhasSalvas.unshift(c); memoria.campanhasSalvas = memoria.campanhasSalvas.slice(0, 30); res.json({ sucesso: true, campanha: c, campanhas: memoria.campanhasSalvas }); });
app.get('/api/campanhas-salvas', (req, res) => res.json({ sucesso: true, campanhas: memoria.campanhasSalvas }));
app.post('/api/campanha', async (req, res) => {
  if (campanhaRodando) return res.status(409).json({ sucesso: false, erro: 'Campanha já está rodando' });
  campanhaRodando = true;
  const contatos = await listarContatos();
  const selecionados = Array.isArray(req.body.selecionados) ? req.body.selecionados.map(limparTelefone) : [];
  const filtro = req.body.filtro || 'todos';
  const busca = textoNormalizado(req.body.busca || '');
  const mensagem = String(req.body.mensagem || '').trim() || '🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.';
  const limite = Math.max(1, Number(req.body.limite || CONFIG.limitePadrao));
  const intervalo = Math.max(1200, Number(req.body.intervalo || CONFIG.intervaloPadrao));
  const agendarPara = String(req.body.agendarPara || '').trim();
  const validadeMinutos = Number(req.body.validadeMinutos || CONFIG.validadeCampanhaMinutos);
  let alvo = contatos;
  if (selecionados.length) alvo = contatos.filter(c => selecionados.includes(limparTelefone(c.telefone)) || selecionados.includes(normalizarTelefoneBR(c.telefone)));
  else if (filtro !== 'todos') alvo = contatos.filter(c => (c.status || 'novo') === filtro);
  if (busca) alvo = alvo.filter(c => textoNormalizado(`${c.nome || ''} ${c.telefone || ''}`).includes(busca));
  alvo = alvo.slice(0, limite);
  const registro = { id: Date.now(), nome: req.body.nome || 'Campanha', total: alvo.length, enviados: 0, respostas: 0, compras: 0, erros: 0, expirados: 0, inicio: agoraISO(), inicio_humano: horaHumana(agoraISO()), fim: null, fim_humano: null, status: agendarPara ? 'agendada' : 'rodando' };
  memoria.campanhas.unshift(registro); memoria.campanhas = memoria.campanhas.slice(0, 30);
  campanhaProgresso = { total: alvo.length, enviados: 0, erros: 0, expirados: 0, status: registro.status, inicio: registro.inicio, fim: null };
  res.json({ sucesso: true, mensagem: agendarPara ? 'Campanha agendada' : 'Campanha iniciada', total: alvo.length });
  async function executar() { campanhaProgresso.status = 'rodando'; registro.status = 'rodando'; const limiteHorario = Date.now() + validadeMinutos * 60 * 1000; for (const c of alvo) { if (Date.now() > limiteHorario) { campanhaProgresso.expirados++; registro.expirados++; continue; } try { await enviarTextoDestino(c.telefone, mensagem); campanhaProgresso.enviados++; registro.enviados++; await salvarContato({ telefone: c.telefone, status: c.status || 'novo', ultima_mensagem: mensagem }); await delay(intervalo); } catch { campanhaProgresso.erros++; registro.erros++; } } campanhaProgresso.status = 'finalizada'; campanhaProgresso.fim = agoraISO(); registro.status = 'finalizada'; registro.fim = campanhaProgresso.fim; registro.fim_humano = horaHumana(registro.fim); campanhaRodando = false; }
  setTimeout(executar, agendarPara ? Math.max(0, new Date(agendarPara).getTime() - Date.now()) : 0);
});
app.get('/api/campanhas', (req, res) => res.json({ sucesso: true, campanhas: memoria.campanhas, progresso: campanhaProgresso }));

function html() { return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reino Zap PRO</title><style>*{box-sizing:border-box}body{margin:0;background:#081427;color:#fff;font-family:Arial,sans-serif}header{background:#172554;padding:20px 14px;text-align:center;border-bottom:4px solid #3b63ff}h1{font-size:24px;margin:0}main{max-width:1180px;margin:auto;padding:10px}.nav{display:flex;gap:8px;overflow-x:auto;margin:10px 0}.nav button{width:auto;min-width:max-content;background:#253760}.card{background:#151c31;border:1px solid #33415f;border-radius:16px;padding:12px;margin-bottom:12px}h2{color:#aac7ff;font-size:18px;margin:0 0 10px}input,textarea,select,button{width:100%;padding:12px;border-radius:10px;border:1px solid #40506e;background:#0a1426;color:#fff;font-size:14px;margin:6px 0}textarea{min-height:105px}button{border:0;background:#4f6bed;font-weight:bold;cursor:pointer}.danger{background:#d12d37}.orange{background:#e96f23}.green{background:#22a852}.gray{background:#475569}.box{background:#090e1e;border-radius:10px;padding:10px;margin-top:8px;white-space:pre-wrap;overflow:auto;font-size:12px}.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.item{background:#0a1426;border:1px solid #3a4a68;border-radius:12px;padding:10px;margin-top:8px}.tag{display:inline-block;background:#3d4d89;padding:4px 8px;border-radius:99px;font-size:11px}.ok{color:#9dff91;font-weight:bold}.warn{color:#ffe17a}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.bar{height:13px;background:#071024;border-radius:99px;overflow:hidden;border:1px solid #304160}.fill{height:100%;background:#4f6bed;width:0%}.alerta{border-color:#ffcc00;box-shadow:0 0 0 2px rgba(255,204,0,.15)}.small{font-size:12px;color:#b8c6e6}.muted{color:#b8c6e6}.actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}@media(min-width:900px){.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.wide{grid-column:1/3}}</style></head><body><header><h1>👑 Reino Zap PRO</h1><p>Painel operacional V17.7.1</p></header><main><div class="nav"><button data-scroll="dash">Dashboard</button><button data-scroll="camp">Campanhas</button><button data-scroll="clientes">Clientes</button><button data-scroll="midia">Imagem/PDF</button><button data-scroll="atendimento">Atendimento</button></div><div class="grid"><section class="card" id="dash"><h2>1. WhatsApp</h2><div id="status">Carregando...</div><button id="btnAtualizar">Atualizar status</button><button class="gray" id="btnNovoQr">Gerar novo QR / Reconectar</button><div id="qr"></div></section><section class="card"><h2>2. Envio rápido</h2><input id="telRapido" inputmode="tel" placeholder="DDD + telefone. Ex: 88994943632"><textarea id="msgRapida">Teste Reino Zap ✅</textarea><button class="orange" id="btnEnvioRapido">Enviar mensagem</button><div id="retRapido" class="box"></div></section><section class="card wide" id="camp"><h2>3. Campanhas profissionais</h2><select id="campPronta"><option value="">Carregar campanha salva/pronta</option><option value="🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.">Hoje tem Reino</option></select><div class="row"><input id="nomeCamp" placeholder="Nome da campanha"><button class="green" id="btnSalvarCamp">Salvar campanha</button></div><textarea id="msgCamp">🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.</textarea><div class="row"><input id="limite" value="20" placeholder="Quantidade máxima de contatos"><input id="intervalo" value="3000" placeholder="Intervalo entre envios em ms"></div><div class="row"><select id="filtro"><option value="todos">Enviar para todos</option><option value="novo">Novos</option><option value="respondeu">Responderam</option><option value="interessado">Interessados</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="aguardando_dados">Aguardando dados</option><option value="aguardando_finalizacao">Aguardando finalização</option><option value="finalizado">Finalizados/compradores</option></select><input id="buscaCamp" placeholder="Buscar dentro da campanha"></div><div class="row"><input id="agendar" type="datetime-local"><input id="validade" value="60" placeholder="Validade em minutos"></div><button class="danger" id="btnCampanha">Enviar / Agendar campanha</button><div class="box"><b>Progresso real</b><div class="bar"><div id="fill" class="fill"></div></div><div id="prog">Parado</div></div><div id="retCamp" class="box"></div></section><section class="card"><h2>4. Adicionar contato</h2><input id="nome" placeholder="Nome"><input id="telefone" inputmode="tel" placeholder="DDD + telefone. Ex: 88994943632"><select id="statusContato"><option value="novo">Novo</option><option value="interessado">Interessado</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="finalizado">Finalizado/comprador</option></select><button id="btnAddContato">Salvar contato</button><div id="retContato" class="box"></div></section><section class="card wide" id="midia"><h2>5. Enviar imagem/PDF</h2><input id="telMidia" inputmode="tel" placeholder="Telefone específico"><input id="arquivoMidia" type="file" accept="image/*,.pdf"><textarea id="legendaMidia" placeholder="Legenda/mensagem junto do arquivo"></textarea><div class="row"><input id="limiteMidia" value="20" placeholder="Limite"><input id="intervaloMidia" value="3000" placeholder="Intervalo"></div><button class="green" id="btnMidiaTel">Enviar para telefone</button><button class="orange" id="btnMidiaSel">Enviar para selecionados</button><div id="retMidia" class="box"></div></section><section class="card"><h2>6. Fluxo automático</h2><div class="box">Cliente recebe campanha → responde quantidade → Pix fixo/estrutura PagBank futura → envia comprovante com texto claro → sistema pede NOME + TELEFONE → telefone validado → atendimento humano toca alerta → atendente envia PDF real dos bilhetes → pedido finalizado.</div></section><section class="card wide"><h2>7. Última mensagem</h2><div id="ultima" class="box">-</div></section><section class="card wide"><h2>8. Histórico de campanhas</h2><div id="historicoCamp"></div></section><section class="card wide" id="clientes"><h2>9. Clientes / Contatos reais</h2><div class="row"><input id="buscaCliente" placeholder="Buscar nome ou telefone"><select id="filtroCliente"><option value="todos">Todos status</option><option value="novo">Novo</option><option value="respondeu">Respondeu</option><option value="interessado">Interessado</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="aguardando_dados">Aguardando dados</option><option value="aguardando_finalizacao">Aguardando finalização</option><option value="finalizado">Finalizado</option></select></div><button id="btnAtualizarClientes">Atualizar / Buscar clientes</button><div class="row"><button id="btnSelTodos">Selecionar todos visíveis</button><button id="btnLimparSel">Limpar seleção</button></div><div class="kpi" id="kpis"></div><div id="lista"></div></section><section class="card wide" id="atendimento"><h2>10. Atendimento humanizado</h2><p class="small">O alerta toca somente quando o cliente enviou comprovante e depois enviou nome/telefone válido.</p><div id="manual"></div></section></div></main><script>var contatos=[],visiveis=[],selecionados=new Set(),ultimoManual=0;function el(id){return document.getElementById(id)}function j(x){return JSON.stringify(x,null,2)}async function api(u,o){var r=await fetch(u,o);var d=await r.json().catch(function(){return{sucesso:false,erro:'Resposta inválida'}});if(!r.ok&&!d.erro)d.erro='Erro HTTP '+r.status;return d}function bloquear(btn,txt){btn.disabled=true;btn.dataset.old=btn.innerText;btn.innerText=txt||'Aguarde...'}function liberar(btn){btn.disabled=false;btn.innerText=btn.dataset.old||btn.innerText}function telLimpo(v){return String(v||'').replace(/\D/g,'')}function bip(){try{var a=new AudioContext(),o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.08;o.start();setTimeout(function(){o.stop();a.close()},350)}catch(e){}}function atualizaProgresso(p){p=p||{};var total=p.total||0,enviados=p.enviados||0,pct=total?Math.round(enviados/total*100):0;el('fill').style.width=pct+'%';el('prog').innerText=(p.status||'parado')+' • enviados: '+enviados+'/'+total+' • '+pct+'% • erros: '+(p.erros||0)+' • expirados: '+(p.expirados||0)}async function atualizar(){try{var s=await api('/status');el('status').innerHTML=s.conectado?'<p class="ok">WhatsApp conectado ✅<br>'+s.numeroConectado+'</p><small>Auth: '+s.auth+' • Versão '+s.versao+'</small>':'<p class="warn">WhatsApp desconectado</p><small>Atualize ou gere novo QR.</small>';el('ultima').innerText=j(s.ultimaMensagemRecebida||'-');var q=await api('/qr');el('qr').innerHTML=q.qr?'<img src="'+q.qr+'" style="width:100%;max-width:300px;background:white;padding:8px">':'Sem QR no momento.';atualizaProgresso(s.campanhaProgresso||{});await carregarCampanhas();await carregarClientes()}catch(e){el('status').innerHTML='Erro ao atualizar: '+e.message}}async function novoQr(){if(!confirm('Isso apaga a sessão atual e gera novo QR. Continuar?'))return;var r=await api('/api/novo-qr',{method:'POST'});alert(r.mensagem||r.erro);setTimeout(atualizar,3500)}async function enviarRapido(){var b=el('btnEnvioRapido');bloquear(b,'Enviando...');try{var r=await api('/api/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:el('telRapido').value,mensagem:el('msgRapida').value})});el('retRapido').innerText=j(r)}finally{liberar(b)}}async function addContato(){var b=el('btnAddContato');bloquear(b,'Salvando...');try{var r=await api('/api/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:el('nome').value,telefone:el('telefone').value,status:el('statusContato').value})});el('retContato').innerText=j(r);await carregarClientes()}finally{liberar(b)}}function carregarCampanhaSelecionada(){if(el('campPronta').value)el('msgCamp').value=el('campPronta').value.replace(/\\n/g,'\n')}async function salvarCampanhaLocal(){if(!el('nomeCamp').value.trim())return alert('Digite o nome da campanha');var r=await api('/api/campanha-salvar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:el('nomeCamp').value,mensagem:el('msgCamp').value})});alert(r.sucesso?'Campanha salva':'Erro: '+r.erro);await carregarCampanhasSalvas()}async function carregarCampanhasSalvas(){var r=await api('/api/campanhas-salvas');var sel=el('campPronta');var base='<option value="">Carregar campanha salva/pronta</option><option value="🎟️ HOJE TEM REINO DA SORTE!\\n\\nBilhete por apenas R$ 2,00.\\n\\nResponda com a quantidade que deseja comprar.">Hoje tem Reino</option>';sel.innerHTML=base+(r.campanhas||[]).map(function(c){return'<option value="'+String(c.mensagem).replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">'+c.nome+'</option>'}).join('')}async function campanha(){var b=el('btnCampanha');bloquear(b,'Enviando...');try{var r=await api('/api/campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:el('nomeCamp').value||'Campanha',mensagem:el('msgCamp').value,limite:el('limite').value,intervalo:el('intervalo').value,filtro:el('filtro').value,busca:el('buscaCamp').value,agendarPara:el('agendar').value,validadeMinutos:el('validade').value,selecionados:Array.from(selecionados)})});el('retCamp').innerText=j(r)}finally{liberar(b)}}function arquivoParaBase64(file){return new Promise(function(resolve,reject){var fr=new FileReader();fr.onload=function(){resolve(fr.result)};fr.onerror=reject;fr.readAsDataURL(file)})}async function enviarMidia(modo){var file=el('arquivoMidia').files[0];if(!file)return alert('Escolha uma imagem ou PDF');var tels=modo==='selecionados'?Array.from(selecionados):[el('telMidia').value];var base64=await arquivoParaBase64(file);var b=modo==='selecionados'?el('btnMidiaSel'):el('btnMidiaTel');bloquear(b,'Enviando arquivo...');try{var r=await api('/api/enviar-midia',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:el('telMidia').value,telefones:tels,intervalo:el('intervaloMidia').value,arquivo:{nome:file.name,mimetype:file.type||'application/pdf',base64:base64,legenda:el('legendaMidia').value}})});el('retMidia').innerText=j(r)}finally{liberar(b)}}async function carregarCampanhas(){var r=await api('/api/campanhas');var arr=r.campanhas||[];el('historicoCamp').innerHTML=arr.map(function(c){return'<div class="item"><b>'+c.nome+'</b><br>Status: '+c.status+'<br>Enviados: '+c.enviados+'/'+c.total+'<br>Erros: '+c.erros+' • Expirados: '+(c.expirados||0)+'<br><span class="muted">'+(c.fim_humano||c.inicio_humano||'')+'</span></div>'}).join('')||'<div class="item">Nenhuma campanha ainda</div>';atualizaProgresso(r.progresso||{})}function filtrarClientes(){var busca=(el('buscaCliente').value||'').toLowerCase();var st=el('filtroCliente').value;visiveis=contatos.filter(function(c){var okSt=st==='todos'||(c.status||'novo')===st;var okBusca=String((c.nome||'')+' '+(c.telefone||'')).toLowerCase().indexOf(busca)>=0;return okSt&&okBusca});renderClientes()}async function carregarClientes(){var r=await api('/api/contatos');contatos=r.contatos||[];var sts=['novo','respondeu','interessado','aguardando_pagamento','aguardando_dados','aguardando_finalizacao','finalizado'];el('kpis').innerHTML=sts.map(function(s){return'<div class="item"><b>'+contatos.filter(function(c){return(c.status||'novo')===s}).length+'</b><br><span class="tag">'+s+'</span></div>'}).join('');filtrarClientes()}function renderClientes(){el('lista').innerHTML=visiveis.map(function(c){return cardCliente(c,false)}).join('')||'<div class="item">Nenhum contato salvo</div>';var man=contatos.filter(function(c){return c.status==='aguardando_finalizacao'});el('manual').innerHTML=man.map(function(c){return cardCliente(c,true)}).join('')||'<div class="item">Nenhum atendimento manual pendente</div>';if(man.length>ultimoManual)bip();ultimoManual=man.length}function cardCliente(c,manual){var tel=c.telefone||'',chk=selecionados.has(tel)||selecionados.has(telLimpo(tel))?'checked':'',cls=manual?'item alerta':'item';return'<div class="'+cls+'"><label><input style="width:auto" type="checkbox" data-sel="'+tel+'" '+chk+'> <b>'+(c.nome||'Sem nome')+'</b></label><br>'+tel+'<br><span class="tag">'+(c.status||'novo')+'</span> <span class="muted">'+(c.atualizado_humano||'')+'</span><br>Última: '+(c.ultima_mensagem||'-')+'<div class="actions"><button data-acao="pix" data-tel="'+tel+'">Pix</button><button data-acao="dados" data-tel="'+tel+'">Dados</button><button class="green" data-acao="finalizar" data-tel="'+tel+'">Finalizar</button></div></div>'}function selecionarVisiveis(){visiveis.forEach(function(c){selecionados.add(c.telefone)});renderClientes()}function limparSelecao(){selecionados.clear();renderClientes()}async function acaoCliente(tel,acao){var r=await api('/api/acao-cliente',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:tel,acao:acao})});alert(r.sucesso?'Ação enviada':'Erro: '+r.erro);carregarClientes()}document.addEventListener('click',function(ev){var t=ev.target;if(t.dataset.scroll)document.getElementById(t.dataset.scroll).scrollIntoView({behavior:'smooth'});if(t.id==='btnAtualizar')atualizar();if(t.id==='btnNovoQr')novoQr();if(t.id==='btnEnvioRapido')enviarRapido();if(t.id==='btnSalvarCamp')salvarCampanhaLocal();if(t.id==='btnCampanha')campanha();if(t.id==='btnAddContato')addContato();if(t.id==='btnAtualizarClientes')carregarClientes();if(t.id==='btnSelTodos')selecionarVisiveis();if(t.id==='btnLimparSel')limparSelecao();if(t.id==='btnMidiaTel')enviarMidia('telefone');if(t.id==='btnMidiaSel')enviarMidia('selecionados');if(t.dataset.acao)acaoCliente(t.dataset.tel,t.dataset.acao)});document.addEventListener('change',function(ev){var t=ev.target;if(t.id==='campPronta')carregarCampanhaSelecionada();if(t.id==='filtroCliente')filtrarClientes();if(t.dataset.sel){if(t.checked)selecionados.add(t.dataset.sel);else selecionados.delete(t.dataset.sel)}});document.addEventListener('input',function(ev){if(ev.target.id==='buscaCliente')filtrarClientes()});setInterval(atualizar,15000);carregarCampanhasSalvas();atualizar();</script></body></html>`; }
app.get('/', (req, res) => res.redirect('/painel'));
app.get('/painel', (req, res) => res.send(html()));
app.listen(PORT, () => console.log('Reino Zap PRO V17.7.1 rodando na porta ' + PORT));
