import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import QRCode from 'qrcode';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@adiwajshing/baileys';

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_DIR = path.join(DATA_DIR, 'session');
for (const dir of [DATA_DIR, PUBLIC_DIR, UPLOAD_DIR, SESSION_DIR]) fs.mkdirSync(dir, { recursive: true });

const files = {
  contacts: path.join(DATA_DIR, 'contacts.json'),
  campaigns: path.join(DATA_DIR, 'campaigns.json'),
  history: path.join(DATA_DIR, 'history.json'),
  scheduled: path.join(DATA_DIR, 'scheduled.json'),
  conversations: path.join(DATA_DIR, 'conversations.json'),
  humanQueue: path.join(DATA_DIR, 'human_queue.json')
};
for (const f of Object.values(files)) if (!fs.existsSync(f)) fs.writeFileSync(f, '[]');

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

let sock = null;
let qrAtual = null;
let connected = false;
let starting = false;
let lastSendLock = new Map();
let supabase = null;

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch { return []; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function onlyDigits(v = '') { return String(v).replace(/\D/g, ''); }
function normalizePhone(v = '') {
  let n = onlyDigits(v);
  if (!n) return '';
  if (n.length === 10 || n.length === 11) n = '55' + n;
  return n;
}
function isValidBrazilPhone(v = '') {
  const n = normalizePhone(v);
  return /^55\d{10,11}$/.test(n);
}
function jidFromPhone(phone) {
  return normalizePhone(phone) + '@s.whatsapp.net';
}
function humanTime(ts = Date.now()) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Hoje ${hm}`;
  if (d.toDateString() === y.toDateString()) return `Ontem ${hm}`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' — ' + hm;
}
function upsertContact({ phone, name = '', tags = [], status = 'novo', source = 'manual' }) {
  const n = normalizePhone(phone);
  if (!isValidBrazilPhone(n)) throw new Error('Telefone inválido ou incompleto');
  const contacts = readJson(files.contacts);
  const idx = contacts.findIndex(c => c.phone === n);
  const now = Date.now();
  if (idx >= 0) {
    contacts[idx] = { ...contacts[idx], name: name || contacts[idx].name || '', tags: Array.from(new Set([...(contacts[idx].tags || []), ...tags])), status: status || contacts[idx].status, updatedAt: now };
  } else {
    contacts.push({ id: 'c_' + now + '_' + Math.random().toString(36).slice(2, 7), phone: n, name, tags, status, source, createdAt: now, updatedAt: now });
  }
  writeJson(files.contacts, contacts);
  return contacts.find(c => c.phone === n);
}
function addConversation(phone, direction, text, meta = {}) {
  const data = readJson(files.conversations);
  data.unshift({ id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), phone: normalizePhone(phone), direction, text, meta, createdAt: Date.now(), time: humanTime() });
  writeJson(files.conversations, data.slice(0, 2000));
}
function safeText(msg) {
  return msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || msg?.documentMessage?.caption || '';
}
function hasAttachment(msg) {
  return !!(msg?.imageMessage || msg?.documentMessage || msg?.videoMessage);
}
function messageOutOfFlow() {
  return 'Este CANAL é exclusivo para compras de bilhetes do Reino da Sorte 🎟️\n\n1. Para continuar a compra digite somente a quantidade de bilhetes:\n\n2) Para outros assuntos clique 👇:\nhttps://wa.me/5588994943632';
}
function getFlow(phone) {
  const contacts = readJson(files.contacts);
  const c = contacts.find(x => x.phone === normalizePhone(phone));
  return c?.flow || { step: 'inicio' };
}
function setFlow(phone, flow) {
  const c = upsertContact({ phone, source: 'whatsapp' });
  const contacts = readJson(files.contacts);
  const idx = contacts.findIndex(x => x.phone === c.phone);
  contacts[idx].flow = flow;
  contacts[idx].status = flow.status || contacts[idx].status;
  contacts[idx].updatedAt = Date.now();
  writeJson(files.contacts, contacts);
}
async function sendMessage(phone, text, options = {}) {
  if (!sock || !connected) throw new Error('WhatsApp não conectado');
  const n = normalizePhone(phone);
  const lockKey = n + ':' + text.slice(0, 30);
  const last = lastSendLock.get(lockKey) || 0;
  if (Date.now() - last < 3500) throw new Error('Bloqueio anti duplicação: aguarde alguns segundos');
  lastSendLock.set(lockKey, Date.now());
  await sock.sendMessage(jidFromPhone(n), { text, ...options });
  addConversation(n, 'out', text, { manual: true });
  return true;
}
async function startWhatsApp() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ['REINO ZAP PRO', 'Chrome', '17.6'] });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) qrAtual = await QRCode.toDataURL(qr);
      if (connection === 'open') { connected = true; qrAtual = null; starting = false; }
      if (connection === 'close') {
        connected = false; starting = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(startWhatsApp, 3000);
      }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const m = messages?.[0];
      if (!m || m.key.fromMe || !m.message) return;
      const phone = normalizePhone(m.key.remoteJid?.split('@')[0] || '');
      if (!phone) return;
      upsertContact({ phone, source: 'whatsapp', tags: ['entrada'] });
      const text = safeText(m.message).trim();
      addConversation(phone, 'in', text || '[arquivo recebido]', { hasAttachment: hasAttachment(m.message) });
      try { await handleFlow(phone, text, hasAttachment(m.message), m); } catch (e) { console.error('flow error', e.message); }
    });
  } catch (e) {
    starting = false;
    console.error('Erro ao iniciar WhatsApp:', e.message);
  }
}
async function handleFlow(phone, text, attachment, raw) {
  const flow = getFlow(phone);
  const quantidade = /^\d{1,4}$/.test(text) ? Number(text) : null;
  if (flow.step === 'inicio') {
    if (quantidade && quantidade > 0) {
      const valor = quantidade * Number(process.env.VALOR_BILHETE || 2);
      setFlow(phone, { step: 'aguardando_comprovante', quantidade, valor, status: 'aguardando pagamento' });
      await sendMessage(phone, `Pedido recebido ✅\n\nQuantidade: ${quantidade} bilhete(s)\nValor: R$ ${valor.toFixed(2).replace('.', ',')}\n\nPIX: ${process.env.PIX_KEY || '5588994943632'}\n\nApós pagar, envie o comprovante aqui.`);
      return;
    }
    await sendMessage(phone, messageOutOfFlow());
    return;
  }
  if (flow.step === 'aguardando_comprovante') {
    if (attachment) {
      setFlow(phone, { ...flow, step: 'aguardando_nome_telefone', comprovanteRecebido: true, status: 'aguardando dados' });
      await sendMessage(phone, 'Comprovante recebido ✅\n\nAgora envie seu NOME COMPLETO e TELEFONE para finalizar o atendimento.');
      return;
    }
    await sendMessage(phone, 'Ainda estou aguardando o comprovante do pagamento. Envie a imagem ou PDF do comprovante aqui.');
    return;
  }
  if (flow.step === 'aguardando_nome_telefone') {
    const possiblePhone = normalizePhone(text);
    const hasValidPhone = isValidBrazilPhone(possiblePhone);
    if (!hasValidPhone) {
      await sendMessage(phone, 'Telefone incompleto ou inválido. Envie novamente com DDD. Exemplo: 88 99999-9999');
      return;
    }
    const name = text.replace(/[+()\-\s]*\d[\d+()\-\s]*/g, '').trim() || 'Cliente';
    upsertContact({ phone, name, tags: ['comprador'], status: 'atendimento humano', source: 'whatsapp' });
    const queue = readJson(files.humanQueue);
    queue.unshift({ id: 'h_' + Date.now(), phone, name, quantidade: flow.quantidade, valor: flow.valor, createdAt: Date.now(), time: humanTime(), status: 'novo' });
    writeJson(files.humanQueue, queue);
    setFlow(phone, { ...flow, step: 'humano', status: 'atendimento humano', name, customerPhone: possiblePhone });
    await sendMessage(phone, 'Dados recebidos ✅\n\nSeu atendimento será continuado por uma pessoa da equipe para emissão dos bilhetes.');
  }
}

app.get('/api/status', (req, res) => res.json({ ok: true, connected, hasQr: !!qrAtual, version: '17.6.1 operacional', time: humanTime() }));
app.post('/api/connect', async (req, res) => { await startWhatsApp(); res.json({ ok: true }); });
app.get('/api/qr', (req, res) => res.json({ ok: true, qr: qrAtual, connected }));
app.post('/api/logout', async (req, res) => { try { if (sock) await sock.logout(); fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR, { recursive: true }); connected = false; qrAtual = null; res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

app.get('/api/contacts', (req, res) => {
  let data = readJson(files.contacts);
  const q = String(req.query.q || '').toLowerCase();
  if (q) data = data.filter(c => (c.name || '').toLowerCase().includes(q) || c.phone.includes(onlyDigits(q)) || (c.tags || []).join(' ').toLowerCase().includes(q));
  res.json({ ok: true, contacts: data.map(c => ({ ...c, createdHuman: humanTime(c.createdAt), updatedHuman: humanTime(c.updatedAt) })) });
});
app.post('/api/contacts', (req, res) => { try { const c = upsertContact(req.body); res.json({ ok: true, contact: c }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
app.post('/api/send', async (req, res) => { try { await sendMessage(req.body.phone, req.body.message); res.json({ ok: true }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
app.post('/api/send-file', upload.single('file'), async (req, res) => {
  try {
    if (!sock || !connected) throw new Error('WhatsApp não conectado');
    const phone = normalizePhone(req.body.phone);
    const buffer = fs.readFileSync(req.file.path);
    const mimetype = req.file.mimetype;
    const fileName = req.file.originalname;
    if (mimetype.startsWith('image/')) await sock.sendMessage(jidFromPhone(phone), { image: buffer, caption: req.body.caption || '' });
    else await sock.sendMessage(jidFromPhone(phone), { document: buffer, mimetype, fileName, caption: req.body.caption || '' });
    addConversation(phone, 'out', req.body.caption || `[arquivo enviado: ${fileName}]`, { fileName, mimetype });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/api/conversations', (req, res) => res.json({ ok: true, conversations: readJson(files.conversations) }));
app.get('/api/human-queue', (req, res) => res.json({ ok: true, queue: readJson(files.humanQueue) }));
app.post('/api/campaigns', (req, res) => {
  const campaigns = readJson(files.campaigns);
  const c = { id: req.body.id || 'camp_' + Date.now(), name: req.body.name || 'Campanha sem nome', message: req.body.message || '', selected: req.body.selected || [], tags: req.body.tags || [], status: 'salva', createdAt: Date.now(), time: humanTime() };
  campaigns.unshift(c); writeJson(files.campaigns, campaigns); res.json({ ok: true, campaign: c });
});
app.get('/api/campaigns', (req, res) => res.json({ ok: true, campaigns: readJson(files.campaigns) }));
app.post('/api/campaigns/:id/send', async (req, res) => {
  const campaigns = readJson(files.campaigns); const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ ok: false, error: 'Campanha não encontrada' });
  const contacts = readJson(files.contacts);
  let targets = contacts.filter(c => (campaign.selected || []).includes(c.phone) || (campaign.tags || []).some(t => (c.tags || []).includes(t)));
  let sent = 0, errors = 0; const details = [];
  for (const c of targets) {
    try { await sendMessage(c.phone, campaign.message); sent++; details.push({ phone: c.phone, ok: true }); await new Promise(r => setTimeout(r, Number(process.env.CAMPAIGN_DELAY_MS || 2500))); }
    catch (e) { errors++; details.push({ phone: c.phone, ok: false, error: e.message }); }
  }
  const history = readJson(files.history); history.unshift({ id: 'hist_' + Date.now(), campaignId: campaign.id, campaignName: campaign.name, sent, errors, total: targets.length, details, createdAt: Date.now(), time: humanTime() }); writeJson(files.history, history);
  res.json({ ok: true, sent, errors, total: targets.length });
});
app.post('/api/schedule', (req, res) => { const data = readJson(files.scheduled); data.unshift({ id: 'sch_' + Date.now(), ...req.body, status: 'aguardando', createdAt: Date.now(), time: humanTime() }); writeJson(files.scheduled, data); res.json({ ok: true }); });
app.get('/api/history', (req, res) => res.json({ ok: true, history: readJson(files.history), scheduled: readJson(files.scheduled) }));

setInterval(async () => {
  const scheduled = readJson(files.scheduled);
  const now = Date.now();
  let changed = false;
  for (const s of scheduled) {
    if (s.status === 'aguardando' && new Date(s.runAt).getTime() <= now) {
      s.status = 'enviando'; changed = true;
      try {
        const r = await fetch(`http://localhost:${PORT}/api/campaigns/${s.campaignId}/send`, { method: 'POST' });
        s.status = r.ok ? 'enviada' : 'erro';
      } catch { s.status = 'erro'; }
      s.sentAt = Date.now(); s.sentHuman = humanTime(s.sentAt);
    }
  }
  if (changed) writeJson(files.scheduled, scheduled);
}, 30000);

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.listen(PORT, () => console.log(`REINO ZAP PRO V17.6 rodando na porta ${PORT}`));
startWhatsApp();
