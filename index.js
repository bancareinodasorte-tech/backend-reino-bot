const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const VERSAO = '14.0.0';
const VALOR_BILHETE = 2;
const PIX_CHAVE = '88994943632';
const PIX_NOME = 'G. DA SILVA';
const MAX_ENVIO_PADRAO = 20;
const DELAY_PADRAO = 8000;

let sock = null;
let qrAtual = '';
let qrDataUrl = '';
let conectado = false;
let numeroConectado = '';
let ultimaMensagemRecebida = null;
let ultimaAtividade = null;
let enviandoCampanha = false;
let progressoCampanha = { ativo: false, total: 0, enviados: 0, falhas: 0, status: 'parado' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function limparTelefone(telefone = '') {
  let t = String(telefone || '')
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .replace('@c.us', '')
    .replace(/\D/g, '');
  if (t && !t.startsWith('55')) t = '55' + t;
  return t;
}

function jidParaTelefone(jid = '') {
  return limparTelefone(String(jid).split('@')[0]);
}

function normalizarTexto(texto = '') {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function detectarInteresse(mensagem = '') {
  const texto = normalizarTexto(mensagem);
  const palavras = [
    'quero', 'comprar', 'participar', 'pix', 'valor', 'manda', 'bilhete', 'bilhetes',
    'tenho interesse', 'vou querer', 'sim', 'quanto', 'chave', 'pedido', 'comprar'
  ];
  return palavras.some((p) => texto.includes(p));
}

function detectarQuantidade(mensagem = '') {
  const texto = String(mensagem || '').trim();
  const match = texto.match(/\b(\d{1,3})\b/);
  if (!match) return null;
  const qtd = Number(match[1]);
  if (!Number.isFinite(qtd) || qtd <= 0 || qtd > 500) return null;
  return qtd;
}

function detectarComprovanteTexto(mensagem = '') {
  const texto = normalizarTexto(mensagem);
  const palavras = ['paguei', 'pago', 'comprovante', 'enviei', 'pix feito', 'feito', 'pagamento feito'];
  return palavras.some((p) => texto.includes(p));
}

function detectarDadosCliente(mensagem = '') {
  const texto = normalizarTexto(mensagem);
  return texto.includes('nome') || texto.includes('telefone') || texto.includes('contato');
}

function extrairTextoMensagem(message = {}) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

function tipoMensagem(message = {}) {
  if (message.imageMessage) return 'imagem';
  if (message.documentMessage) return 'documento';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.stickerMessage) return 'figurinha';
  return 'texto';
}

function escolherMensagem(mensagens = []) {
  const limpas = mensagens.map((m) => String(m || '').trim()).filter(Boolean);
  if (!limpas.length) return '';
  return limpas[Math.floor(Math.random() * limpas.length)];
}

async function supabaseRequest(method, tabela, body = null, query = '') {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('SUPABASE_URL ou SUPABASE_KEY ausente no Render.');
  }
  const url = `${SUPABASE_URL}/rest/v1/${tabela}${query}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
  if (method === 'POST' || method === 'PATCH') {
    headers.Prefer = 'resolution=merge-duplicates,return=representation';
  }
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    throw new Error(`Supabase ${method} ${tabela}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function listarContatos() {
  try {
    return await supabaseRequest('GET', 'contatos', null, '?select=*&order=id.desc');
  } catch (e) {
    console.log('Erro listarContatos:', e.message);
    return [];
  }
}

async function salvarContato({ telefone, nome = '', status = 'novo', ultima_mensagem = '', interessado = false }) {
  const tel = limparTelefone(telefone);
  if (!tel) throw new Error('Telefone obrigatório');

  const dados = { telefone: tel, nome, status, ultima_mensagem, interessado };
  try {
    return await supabaseRequest('POST', 'contatos', dados, '?on_conflict=telefone');
  } catch (e) {
    console.log('Falha salvar contato completo, tentando mínimo:', e.message);
    return await supabaseRequest('POST', 'contatos', { telefone: tel, nome, ultima_mensagem, interessado }, '?on_conflict=telefone');
  }
}

async function atualizarStatusContato(telefone, status, extra = {}) {
  const tel = limparTelefone(telefone);
  try {
    const body = { status, ...extra };
    return await supabaseRequest('PATCH', 'contatos', body, `?telefone=eq.${encodeURIComponent(tel)}`);
  } catch (e) {
    console.log('Falha atualizar status:', e.message);
    return null;
  }
}

async function registrarResposta({ telefone, mensagem, interessado = false, tipo = 'texto', status = '' }) {
  try {
    await supabaseRequest('POST', 'respostas', { telefone: limparTelefone(telefone), mensagem, interessado }, '');
  } catch (e) {
    console.log('Falha registrar resposta:', e.message);
  }
  if (interessado) {
    try {
      await supabaseRequest('POST', 'interessados', { telefone: limparTelefone(telefone), origem: 'whatsapp' }, '');
    } catch (e) {
      console.log('Falha registrar interessado:', e.message);
    }
  }
}

async function enviarTexto(telefone, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  const numero = limparTelefone(telefone);
  const candidatos = [];
  if (numero) candidatos.push(numero);
  if (numero.startsWith('55') && numero.length === 13 && numero[4] === '9') {
    candidatos.push(numero.slice(0, 4) + numero.slice(5));
  }
  if (numero.startsWith('55') && numero.length === 12) {
    candidatos.push(numero.slice(0, 4) + '9' + numero.slice(4));
  }

  let ultimoErro = null;
  for (const n of [...new Set(candidatos)]) {
    try {
      const onwa = await sock.onWhatsApp(n);
      const jid = onwa?.[0]?.jid || `${n}@s.whatsapp.net`;
      const resposta = await sock.sendMessage(jid, { text: texto });
      return { numeroOriginal: numero, numeroUsado: n, jid, resposta };
    } catch (e) {
      ultimoErro = e;
    }
  }
  throw ultimoErro || new Error('Falha ao enviar mensagem');
}

function textoPerguntarQuantidade() {
  return `Perfeito! 🎟️\n\nQuantos bilhetes você deseja?\nDigite apenas o número.\n\nExemplo: 1, 2, 5, 10...`;
}

function textoPix(qtd) {
  const total = qtd * VALOR_BILHETE;
  return `Perfeito! 🎟️\n\nVocê escolheu: ${qtd} bilhete${qtd > 1 ? 's' : ''}\n\n💰 Total: R$ ${total.toFixed(2).replace('.', ',')}\n\n📲 Pagamento via Pix:\nChave: ${PIX_CHAVE}\nNome: ${PIX_NOME}\n\n⚠️ Envie o comprovante aqui para confirmar seu pedido.`;
}

function textoComprovanteRecebido() {
  return `Recebido! ✅\n\n- Preencha os dados\nNOME:\nTELEFONE:\n\n⚠️ Aguarde o comprovante dos seus bilhetes`;
}

function textoDadosRecebidos() {
  return `Dados recebidos! ✅\n\nAguarde enquanto seu pedido é finalizado.`;
}

function textoAgradecimento() {
  return `REINO DA SORTE AGRADECE SUA COMPRA\n\n🍀 Boa Sorte 🍀`;
}

async function processarMensagemEntrada(msg) {
  try {
    const key = msg.key || {};
    const message = msg.message || {};
    const fromMe = !!key.fromMe;
    const jid = key.remoteJid || '';
    if (!jid || jid.includes('@g.us')) return;

    const telefone = jidParaTelefone(jid);
    const texto = extrairTextoMensagem(message);
    const tipo = tipoMensagem(message);
    const quantidade = detectarQuantidade(texto);
    const interessado = detectarInteresse(texto) || !!quantidade || tipo !== 'texto';

    ultimaMensagemRecebida = {
      de: jid,
      telefone,
      mensagem: texto || `[${tipo}]`,
      tipo,
      interessado,
      quantidade,
      comprovante: tipo === 'imagem' || tipo === 'documento' || detectarComprovanteTexto(texto),
      data: new Date().toISOString()
    };
    ultimaAtividade = ultimaMensagemRecebida.data;

    if (fromMe) {
      if (message.documentMessage) {
        await enviarTexto(telefone, textoAgradecimento()).catch((e) => console.log('Falha agradecimento:', e.message));
        await atualizarStatusContato(telefone, 'finalizado');
      }
      return;
    }

    let status = interessado ? 'interessado' : 'novo';
    if (quantidade) status = 'aguardando_pagamento';
    if (ultimaMensagemRecebida.comprovante) status = 'aguardando_dados';
    if (detectarDadosCliente(texto)) status = 'aguardando_finalizacao';

    await salvarContato({ telefone, nome: '', status, ultima_mensagem: texto || `[${tipo}]`, interessado });
    await registrarResposta({ telefone, mensagem: texto || `[${tipo}]`, interessado, tipo, status });

    if (ultimaMensagemRecebida.comprovante) {
      await enviarTexto(telefone, textoComprovanteRecebido());
      return;
    }

    if (quantidade) {
      await enviarTexto(telefone, textoPix(quantidade));
      return;
    }

    if (interessado) {
      await enviarTexto(telefone, textoPerguntarQuantidade());
      return;
    }
  } catch (e) {
    console.log('Erro processar mensagem:', e.message);
  }
}

async function iniciarWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_reino_zap');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['Reino Zap', 'Chrome', '14.0.0']
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const deveReconectar = statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp desconectado. Reconectar:', deveReconectar, 'status:', statusCode);
        if (deveReconectar) setTimeout(iniciarWhatsApp, 3000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages || []) {
        if (m.message) await processarMensagemEntrada(m);
      }
    });
  } catch (e) {
    console.log('Erro iniciar WhatsApp:', e.message);
    setTimeout(iniciarWhatsApp, 5000);
  }
}

function renderPainel() {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Reino Zap V14</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b1428;color:#fff;font-family:Arial,sans-serif}header{background:#182a57;padding:34px 18px;text-align:center;border-bottom:5px solid #4169f6}h1{margin:0;font-size:38px}header p{font-size:17px;margin:10px 0 0}.wrap{max-width:760px;margin:auto;padding:18px}.card{background:#151d35;border:1px solid #34415f;border-radius:18px;margin:18px 0;padding:20px}h2{color:#a9c8ff;font-size:26px;margin-top:0}input,textarea,select,button{width:100%;padding:15px;border-radius:14px;border:1px solid #415070;background:#0e172b;color:#fff;font-size:16px;margin:8px 0}textarea{min-height:110px}button{border:0;background:#4969e8;font-weight:bold;cursor:pointer}.green{background:#16a34a}.orange{background:#ea6d22}.red{background:#d72835}.status{color:#86efac;font-weight:bold}.box{background:#070c1d;border-radius:14px;padding:14px;white-space:pre-wrap;color:#fffbe0;overflow:auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mini{background:#071024;border:1px solid #34415f;border-radius:14px;padding:12px;margin:8px 0}.tag{display:inline-block;padding:5px 9px;border-radius:12px;background:#243866;color:#bcd2ff;font-size:12px}.warn{color:#fde68a}img.qr{width:100%;max-width:330px;background:#fff;padding:10px;border-radius:14px}small{color:#cbd5e1}@media(max-width:620px){h1{font-size:34px}.grid{grid-template-columns:1fr}}</style></head>
<body><header><h1>👑 Reino Zap</h1><p>Painel profissional de vendas por WhatsApp V14</p></header>
<div class="wrap">
<div class="card"><h2>1. WhatsApp</h2><div id="waStatus">Carregando...</div><button onclick="carregar()">Atualizar status</button><div id="qr"></div></div>
<div class="card"><h2>2. Campanha / Oferta</h2><small>Use 2 ou mais textos separados por --- para embaralhar e reduzir risco de bloqueio.</small><textarea id="campanha">🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.\nEx: 1, 2, 5, 10...\n\n🍀 Boa sorte!\n---\n🍀 Bora participar do sorteio de hoje?\n\n🎟️ Bilhete: R$ 2,00\n\nResponda só com a quantidade de bilhetes.\nEx: 2, 5 ou 10.</textarea><input id="limite" value="20" placeholder="Quantidade máxima por envio"><input id="delay" value="8000" placeholder="Intervalo em milissegundos"><select id="filtro"><option value="todos">Todos</option><option value="novo">Novos</option><option value="interessado">Interessados</option><option value="sem_resposta">Sem resposta</option><option value="aguardando_pagamento">Aguardando pagamento</option></select><button class="red" onclick="enviarCampanha()">Enviar campanha</button><div id="campanhaResp" class="box"></div></div>
<div class="card"><h2>3. Adicionar contato</h2><input id="nome" placeholder="Nome opcional"><input id="telefone" placeholder="Telefone com DDD"><button onclick="salvarContato()">Salvar contato</button><div id="contatoResp" class="box"></div></div>
<div class="card"><h2>4. Fluxo automático</h2><div class="box">Bilhete: R$ 2,00\nPix: 88994943632\nNome no Pix: G. DA SILVA\n\nCliente responde quantidade → sistema calcula valor e envia Pix.\nCliente manda imagem/PDF/paguei → sistema pede NOME e TELEFONE.\nAtendente envia PDF → sistema agradece.</div></div>
<div class="card"><h2>5. Última mensagem recebida</h2><div id="ultima" class="box">-</div></div>
<div class="card"><h2>6. Clientes</h2><button onclick="carregarContatos()">Atualizar clientes</button><div id="resumo" class="grid"></div><div id="lista"></div></div>
</div>
<script>
async function j(url,opt){const r=await fetch(url,opt);return await r.json()}
function esc(x){return String(x||'').replace(/[&<>]/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]))}
async function carregar(){const s=await j('/api/status');document.getElementById('waStatus').innerHTML=s.conectado?'<p class=status>WhatsApp conectado ✅<br>'+esc(s.numeroConectado)+'</p>':'<p class=warn>WhatsApp desconectado. Escaneie o QR.</p>';document.getElementById('ultima').textContent=JSON.stringify(s.ultimaMensagemRecebida||'-',null,2);document.getElementById('qr').innerHTML=s.qrDataUrl?'<img class=qr src="'+s.qrDataUrl+'">':'<small>Sem QR no momento.</small>';carregarContatos()}
async function salvarContato(){const r=await j('/api/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:document.getElementById('nome').value,telefone:document.getElementById('telefone').value})});document.getElementById('contatoResp').textContent=JSON.stringify(r,null,2);carregarContatos()}
async function enviarCampanha(){document.getElementById('campanhaResp').textContent='Enviando...';const mensagens=document.getElementById('campanha').value.split('---');const r=await j('/api/campanha/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagens,limite:Number(document.getElementById('limite').value||20),delayMs:Number(document.getElementById('delay').value||8000),filtro:document.getElementById('filtro').value})});document.getElementById('campanhaResp').textContent=JSON.stringify(r,null,2);carregarContatos()}
async function carregarContatos(){const r=await j('/api/contatos');const contatos=r.contatos||[];const por={novo:0,interessado:0,aguardando_pagamento:0,aguardando_dados:0,aguardando_finalizacao:0,finalizado:0};contatos.forEach(c=>{por[c.status||'novo']=(por[c.status||'novo']||0)+1});document.getElementById('resumo').innerHTML=Object.keys(por).map(k=>'<div class=mini><b>'+por[k]+'</b><br><span class=tag>'+k+'</span></div>').join('');document.getElementById('lista').innerHTML=contatos.map(c=>'<div class=mini><b>'+esc(c.nome||'Sem nome')+'</b><br>'+esc(c.telefone)+'<br><span class=tag>'+esc(c.status||'novo')+'</span><br>Última: '+esc(c.ultima_mensagem||'-')+'</div>').join('')||'<p>Nenhum contato.</p>'}
carregar();setInterval(carregar,15000)
</script></body></html>`;
}

app.get('/', (req, res) => res.redirect('/painel'));
app.get('/painel', (req, res) => res.send(renderPainel()));
app.get('/status', (req, res) => res.json({ online: true, sistema: 'Reino Zap', versao: VERSAO, motor: 'baileys', conectado, numeroConectado, temQr: !!qrDataUrl, ultimaMensagemRecebida }));
app.get('/api/status', (req, res) => res.json({ online: true, versao: VERSAO, conectado, numeroConectado, qrDataUrl, ultimaMensagemRecebida, progressoCampanha }));

app.get('/api/contatos', async (req, res) => {
  const contatos = await listarContatos();
  res.json({ sucesso: true, total: contatos.length, contatos });
});

app.post('/api/contatos', async (req, res) => {
  try {
    const r = await salvarContato({ telefone: req.body.telefone, nome: req.body.nome || '', status: req.body.status || 'novo' });
    res.json({ sucesso: true, contato: r });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

app.post('/api/campanha/enviar', async (req, res) => {
  if (enviandoCampanha) return res.status(409).json({ sucesso: false, erro: 'Já existe campanha em envio.' });
  try {
    const mensagens = Array.isArray(req.body.mensagens) ? req.body.mensagens : [req.body.mensagem || ''];
    const limite = Math.min(Number(req.body.limite || MAX_ENVIO_PADRAO), 500);
    const delayMs = Math.max(Number(req.body.delayMs || DELAY_PADRAO), 2000);
    const filtro = req.body.filtro || 'todos';
    const contatos = await listarContatos();
    let alvos = contatos.filter((c) => c.telefone);
    if (filtro !== 'todos') alvos = alvos.filter((c) => (c.status || 'novo') === filtro);
    alvos = alvos.slice(0, limite);

    enviandoCampanha = true;
    progressoCampanha = { ativo: true, total: alvos.length, enviados: 0, falhas: 0, status: 'enviando' };
    const resultados = [];
    for (const c of alvos) {
      const texto = escolherMensagem(mensagens);
      if (!texto) continue;
      try {
        const envio = await enviarTexto(c.telefone, texto);
        progressoCampanha.enviados++;
        resultados.push({ telefone: c.telefone, sucesso: true, jid: envio.jid });
        await atualizarStatusContato(c.telefone, c.status || 'sem_resposta', { ultima_mensagem: texto });
      } catch (e) {
        progressoCampanha.falhas++;
        resultados.push({ telefone: c.telefone, sucesso: false, erro: e.message });
      }
      await sleep(delayMs);
    }
    progressoCampanha.status = 'finalizado';
    progressoCampanha.ativo = false;
    enviandoCampanha = false;
    res.json({ sucesso: true, total: alvos.length, resultados, progressoCampanha });
  } catch (e) {
    enviandoCampanha = false;
    progressoCampanha.ativo = false;
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

app.post('/api/enviar', async (req, res) => {
  try {
    const envio = await enviarTexto(req.body.telefone, req.body.mensagem || 'Teste Reino Zap ✅');
    res.json({ sucesso: true, envio });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Reino Zap V14 ativo na porta ${PORT}`);
});

iniciarWhatsApp();
