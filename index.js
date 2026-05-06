import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
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
  versao: '15.1.0',
  bilheteValor: 2,
  pixChave: '88994943632',
  pixNome: 'G. DA SILVA',
  intervaloPadrao: 8000,
  limitePadrao: 20
};

let sock = null;
let qrDataUrl = '';
let conectado = false;
let numeroConectado = '';
let ultimaMensagem = null;
let campanhaRodando = false;
let campanhaProgresso = { total: 0, enviados: 0, erros: 0, status: 'parado' };
const memoria = { contatos: new Map(), mensagens: [] };

function limparTelefone(telefone = '') {
  return String(telefone).replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
}

function moeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalizarTexto(v = '') {
  return String(v || '').trim().toLowerCase();
}

function detectarInteresse(texto = '') {
  const t = normalizarTexto(texto);
  if (!t) return false;
  const palavras = ['quero', 'comprar', 'participar', 'bilhete', 'bilhetes', 'pix', 'valor', 'manda', 'sim', 'vou querer', 'tenho interesse', 'quanto', 'pode ser', 'ok', 'oi', 'olá', 'ola'];
  return palavras.some(p => t.includes(p));
}

function detectarQuantidade(texto = '') {
  const t = normalizarTexto(texto);
  const m = t.match(/\b(\d{1,4})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return null;
  return n;
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
  if (m.imageMessage || m.documentMessage) return true;
  const t = normalizarTexto(texto);
  return ['paguei', 'pago', 'comprovante', 'enviei', 'transferi', 'pix feito', 'feito'].some(p => t.includes(p));
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
  return `Recebido! ✅\n\n- Preencha os dados\nNOME:\nTELEFONE:\n\n⚠️ Aguarde o comprovante dos seus bilhetes`;
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
    return await r.json().catch(() => null);
  } catch (e) {
    console.log('Supabase falhou:', e.message);
    return null;
  }
}

async function salvarContato({ telefone, nome = '', status = 'novo', ultima_mensagem = '', interessado = false, quantidade = null, comprovante = false, jid = '' }) {
  const tel = limparTelefone(telefone);
  if (!tel) return;
  const atual = memoria.contatos.get(tel) || {};
  const contato = {
    telefone: tel,
    nome: nome || atual.nome || '',
    status: status || atual.status || 'novo',
    ultima_mensagem: ultima_mensagem || atual.ultima_mensagem || '',
    interessado: Boolean(interessado || atual.interessado),
    quantidade: quantidade || atual.quantidade || null,
    comprovante: Boolean(comprovante || atual.comprovante),
    jid: jid || atual.jid || ''
  };
  memoria.contatos.set(tel, contato);

  const bancoContato = { ...contato };
  delete bancoContato.jid;
  await supabase('POST', 'contatos?on_conflict=telefone', bancoContato);
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

function jidDoNumero(telefone = '') {
  const limpo = limparTelefone(telefone);
  return `${limpo}@s.whatsapp.net`;
}

async function resolverJidDestino(telefone) {
  const limpo = limparTelefone(telefone);
  if (!limpo) throw new Error('Telefone vazio');
  if (String(telefone).includes('@')) return String(telefone);
  const candidato = `${limpo}@s.whatsapp.net`;
  try {
    const existe = await sock.onWhatsApp(candidato);
    return existe?.[0]?.jid || candidato;
  } catch {
    return candidato;
  }
}

async function enviarTexto(telefone, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  const jidFinal = await resolverJidDestino(telefone);
  const resp = await sock.sendMessage(jidFinal, { text: texto });
  return { jid: jidFinal, resposta: resp };
}

async function enviarTextoParaJid(jid, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  if (!jid) throw new Error('JID vazio');
  const resp = await sock.sendMessage(jid, { text: texto });
  return { jid, resposta: resp };
}

async function processarMensagemRecebida(msg) {
  const fromMe = Boolean(msg.key?.fromMe);
  const jid = msg.key?.remoteJid || '';
  const telefone = limparTelefone(jid);
  const texto = extrairTextoMensagem(msg.message);
  const comprovante = detectarComprovante(msg, texto);
  const qtd = detectarQuantidade(texto);
  const interessado = detectarInteresse(texto) || Boolean(qtd) || comprovante;

  ultimaMensagem = {
    de: jid,
    telefone,
    mensagem: texto || (comprovante ? '[comprovante]' : '[mídia]'),
    tipo: comprovante ? 'comprovante/midia' : 'texto',
    interessado,
    quantidade: qtd,
    comprovante,
    data: new Date().toISOString()
  };

  if (fromMe) {
    if (detectarPdfDoAtendente(msg)) {
      await enviarTextoParaJid(jid, agradecimentoFinal());
      await salvarContato({ telefone, jid, status: 'finalizado', ultima_mensagem: '[PDF enviado pelo atendente]' });
    }
    return;
  }

  await salvarResposta({ telefone, mensagem: texto || '[mídia/comprovante]', interessado });

  if (comprovante) {
    await salvarContato({ telefone, jid, status: 'aguardando_dados', ultima_mensagem: texto || '[comprovante]', interessado: true, comprovante: true });
    await enviarTextoParaJid(jid, respostaComprovante());
    return;
  }

  if (qtd) {
    await salvarContato({ telefone, jid, status: 'aguardando_pagamento', ultima_mensagem: texto, interessado: true, quantidade: qtd });
    await enviarTextoParaJid(jid, respostaQuantidade(qtd));
    return;
  }

  if (interessado) {
    await salvarContato({ telefone, jid, status: 'interessado', ultima_mensagem: texto, interessado: true });
    await enviarTextoParaJid(jid, perguntaQuantidade());
  } else {
    await salvarContato({ telefone, jid, status: 'respondeu', ultima_mensagem: texto, interessado: false });
  }
}

async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Reino Zap PRO', 'Chrome', '15.1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr);
      conectado = false;
      numeroConectado = '';
    }
    if (connection === 'open') {
      conectado = true;
      qrDataUrl = '';
      numeroConectado = sock.user?.id || '';
      console.log('WhatsApp conectado:', numeroConectado);
    }
    if (connection === 'close') {
      conectado = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log('WhatsApp desconectado:', reason);
      if (reason !== DisconnectReason.loggedOut) setTimeout(() => iniciarWhatsApp().catch(e => console.log('Reinicio falhou:', e.message)), 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('messages.upsert:', type, messages?.length || 0);
    for (const msg of messages || []) {
      try {
        if (!msg.message) continue;
        if (msg.key?.remoteJid === 'status@broadcast') continue;
        await processarMensagemRecebida(msg);
      } catch (e) {
        console.log('Erro processando mensagem:', e.message);
      }
    }
  });
}

iniciarWhatsApp().catch(e => console.log('Erro ao iniciar WhatsApp:', e.message));

app.get('/status', (req, res) => res.json({
  online: true,
  sistema: CONFIG.sistema,
  versao: CONFIG.versao,
  conectado,
  numeroConectado,
  temQr: Boolean(qrDataUrl),
  ultimaMensagemRecebida: ultimaMensagem,
  campanhaProgresso
}));

app.get('/qr', (req, res) => res.json({ conectado, numeroConectado, qr: qrDataUrl }));
app.get('/api/contatos', async (req, res) => res.json({ sucesso: true, contatos: await listarContatos() }));
app.post('/api/contatos', async (req, res) => {
  await salvarContato({ telefone: req.body.telefone, nome: req.body.nome, status: 'novo' });
  res.json({ sucesso: true });
});
app.post('/api/enviar', async (req, res) => {
  try {
    const envio = await enviarTexto(req.body.telefone, req.body.mensagem);
    res.json({ sucesso: true, envio });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});
app.post('/api/campanha', async (req, res) => {
  if (campanhaRodando) return res.status(409).json({ sucesso: false, erro: 'Campanha já está rodando' });
  campanhaRodando = true;
  const contatos = await listarContatos();
  const textos = String(req.body.mensagem || '').split('---').map(t => t.trim()).filter(Boolean);
  const limite = Number(req.body.limite || CONFIG.limitePadrao);
  const intervalo = Number(req.body.intervalo || CONFIG.intervaloPadrao);
  const filtro = req.body.filtro || 'todos';
  const filtrados = filtro === 'todos' ? contatos : contatos.filter(c => (c.status || 'novo') === filtro);
  const alvo = filtrados.slice(0, limite);
  campanhaProgresso = { total: alvo.length, enviados: 0, erros: 0, status: 'rodando' };
  res.json({ sucesso: true, mensagem: 'Campanha iniciada', total: alvo.length });
  for (const c of alvo) {
    try {
      const texto = textos[Math.floor(Math.random() * textos.length)] || 'HOJE TEM REINO DA SORTE! 🎟️\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.';
      await enviarTexto(c.telefone, texto);
      campanhaProgresso.enviados++;
      await salvarContato({ telefone: c.telefone, nome: c.nome, status: c.status || 'novo', ultima_mensagem: texto });
      await delay(intervalo);
    } catch (e) {
      campanhaProgresso.erros++;
      console.log('Erro campanha:', c.telefone, e.message);
    }
  }
  campanhaProgresso.status = 'finalizada';
  campanhaRodando = false;
});

function html() { return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reino Zap PRO</title><style>
*{box-sizing:border-box}body{margin:0;background:#081427;color:#fff;font-family:Arial,sans-serif}header{background:#172554;padding:24px 16px;text-align:center;border-bottom:4px solid #3b63ff}h1{font-size:36px;margin:0}main{max-width:1180px;margin:auto;padding:18px}.grid{display:grid;grid-template-columns:1fr;gap:16px}.card{background:#151c31;border:1px solid #33415f;border-radius:18px;padding:18px}h2{color:#aac7ff;font-size:25px;margin:0 0 14px}input,textarea,select,button{width:100%;padding:15px;border-radius:13px;border:1px solid #40506e;background:#0a1426;color:#fff;font-size:16px;margin:8px 0}textarea{min-height:120px}button{border:0;background:#4f6bed;font-weight:bold;cursor:pointer}.danger{background:#d12d37}.orange{background:#e96f23}.box{background:#090e1e;border-radius:12px;padding:14px;margin-top:10px;white-space:pre-wrap;overflow:auto}.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.item{background:#0a1426;border:1px solid #3a4a68;border-radius:14px;padding:13px;margin-top:10px}.tag{display:inline-block;background:#3d4d89;padding:5px 10px;border-radius:99px;font-size:12px}.ok{color:#9dff91;font-weight:bold}.nav{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}.nav button{background:#22345e}@media(min-width:900px){.grid{grid-template-columns:1fr 1fr}.wide{grid-column:1/3}}
</style></head><body><header><h1>👑 Reino Zap PRO</h1><p>Painel profissional de vendas por WhatsApp V15.1</p></header><main>
<div class="nav"><button onclick="rolar('dash')">Dashboard</button><button onclick="rolar('camp')">Campanhas</button><button onclick="rolar('clientes')">Clientes</button><button onclick="rolar('fluxo')">Fluxo</button></div>
<div class="grid">
<section class="card" id="dash"><h2>1. WhatsApp</h2><div id="status">Carregando...</div><button onclick="atualizar()">Atualizar status</button><div id="qr"></div></section>
<section class="card"><h2>2. Envio rápido</h2><input id="telRapido" placeholder="Telefone"><textarea id="msgRapida">Teste Reino Zap ✅</textarea><button class="orange" onclick="enviarRapido()">Enviar mensagem</button><div id="retRapido" class="box"></div></section>
<section class="card wide" id="camp"><h2>3. Campanha / Oferta</h2><p>Use 2 ou mais textos separados por --- para embaralhar.</p><textarea id="msgCamp">🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.\n---\n🍀 Quer participar do Reino da Sorte hoje?\n\nBilhete R$ 2,00. Responda só com a quantidade.</textarea><input id="limite" value="20" placeholder="Limite"><input id="intervalo" value="8000" placeholder="Intervalo ms"><select id="filtro"><option value="todos">Todos</option><option value="novo">Novos</option><option value="respondeu">Responderam</option><option value="interessado">Interessados</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="aguardando_dados">Aguardando dados</option></select><button class="danger" onclick="campanha()">Enviar campanha</button><div id="retCamp" class="box"></div></section>
<section class="card"><h2>4. Adicionar contato</h2><input id="nome" placeholder="Nome"><input id="telefone" placeholder="Telefone"><button onclick="addContato()">Salvar contato</button><div id="retContato" class="box"></div></section>
<section class="card" id="fluxo"><h2>5. Fluxo automático</h2><div class="box">Bilhete: R$ 2,00\nPix: 88994943632\nNome no Pix: G. DA SILVA\n\nCliente responde quantidade → sistema envia Pix.\nCliente manda imagem/PDF/paguei → sistema pede NOME e TELEFONE.\nAtendente envia PDF → sistema agradece.</div></section>
<section class="card wide"><h2>6. Última mensagem recebida</h2><div id="ultima" class="box">-</div></section>
<section class="card wide" id="clientes"><h2>7. Clientes</h2><button onclick="carregarClientes()">Atualizar clientes</button><div class="kpi" id="kpis"></div><div id="lista"></div></section>
</div></main><script>
const j=x=>JSON.stringify(x,null,2);function rolar(id){document.getElementById(id).scrollIntoView({behavior:'smooth'})}
async function api(u,o){let r=await fetch(u,o);return await r.json()}async function atualizar(){let s=await api('/status');document.getElementById('status').innerHTML=s.conectado?'<p class="ok">WhatsApp conectado ✅<br>'+s.numeroConectado+'</p>':'<p>WhatsApp desconectado</p>';document.getElementById('ultima').innerText=j(s.ultimaMensagemRecebida||'-');let q=await api('/qr');document.getElementById('qr').innerHTML=q.qr?'<img src="'+q.qr+'" style="width:100%;max-width:300px">':'Sem QR no momento.';carregarClientes()}
async function enviarRapido(){let r=await api('/api/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:telRapido.value,mensagem:msgRapida.value})});retRapido.innerText=j(r)}
async function addContato(){let r=await api('/api/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nome.value,telefone:telefone.value})});retContato.innerText=j(r);carregarClientes()}
async function campanha(){let r=await api('/api/campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem:msgCamp.value,limite:limite.value,intervalo:intervalo.value,filtro:filtro.value})});retCamp.innerText=j(r)}
async function carregarClientes(){let r=await api('/api/contatos');let cs=r.contatos||[];let sts=['novo','respondeu','interessado','aguardando_pagamento','aguardando_dados','finalizado'];kpis.innerHTML=sts.map(s=>'<div class="item"><b>'+cs.filter(c=>(c.status||'novo')===s).length+'</b><br><span class="tag">'+s+'</span></div>').join('');lista.innerHTML=cs.map(c=>'<div class="item"><b>'+(c.nome||'Sem nome')+'</b><br>'+c.telefone+'<br><span class="tag">'+(c.status||'novo')+'</span><br>Última: '+(c.ultima_mensagem||'-')+'</div>').join('')}
setInterval(atualizar,10000);atualizar();</script></body></html>`; }

app.get('/', (req, res) => res.redirect('/painel'));
app.get('/painel', (req, res) => res.send(html()));
app.listen(PORT, () => console.log('Reino Zap PRO V15.1 rodando na porta ' + PORT));
