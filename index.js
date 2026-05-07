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
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const CONFIG = {
  sistema: 'Reino Zap PRO',
  versao: '17.2 RECUPERAÇÃO ESTÁVEL',
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
let campanhaProgresso = { total: 0, enviados: 0, erros: 0, status: 'parado', inicio: null, fim: null };
const memoria = { contatos: new Map(), mensagens: [], campanhas: [] };
const processadas = new Map();

function limparTelefone(telefone = '') {
  return String(telefone).replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
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

function detectarComprovante(msg, texto = '') {
  const m = msg?.message || {};
  const t = textoNormalizado(texto);
  const temMidia = Boolean(m.imageMessage || m.documentMessage);
  const falaPagamento = ['paguei', 'pago', 'comprovante', 'enviei', 'transferi', 'pix feito', 'segue comprovante'].some(p => t.includes(p));
  if (m.documentMessage) return true;
  if (temMidia && falaPagamento) return true;
  if (!temMidia && falaPagamento) return true;
  return false;
}

function detectarPdfDoAtendente(msg) {
  const m = msg?.message || {};
  return Boolean(msg?.key?.fromMe && m.documentMessage);
}

function extrairTextoMensagem(message = {}) {
  return message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.documentMessage?.caption ||
    message.videoMessage?.caption ||
    '';
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

function agradecimentoFinal() {
  return `REINO DA SORTE AGRADECE SUA COMPRA\n\n🍀 Boa Sorte 🍀`;
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
    const e = await r.text();
    console.log('Supabase erro:', method, path, e);
    return null;
  }
  if (r.status === 204) return null;
  try { return await r.json(); } catch { return null; }
}

async function authRead(id) {
  const data = await supabase('GET', `zap_auth?select=value&id=eq.${encodeURIComponent(id)}&limit=1`);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;
  return JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
}

async function authWrite(id, value) {
  const safe = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  await supabase('POST', 'zap_auth?on_conflict=id', { id, value: safe, updated_at: new Date().toISOString() });
}

async function authDelete(id) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/zap_auth?id=eq.${encodeURIComponent(id)}`, {
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
          await Promise.all(ids.map(async (id) => {
            let value = await authRead(`${type}-${id}`);
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
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? authWrite(key, value) : authDelete(key));
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
    data.forEach(c => memoria.contatos.set(c.telefone, c));
    return data;
  }
  return Array.from(memoria.contatos.values()).reverse();
}

async function enviarTextoDestino(destino, texto) {
  if (!sock || !conectado) throw new Error('WhatsApp não conectado');
  let jidFinal = destino;
  if (!String(destino).includes('@')) {
    const jid = jidDoNumero(destino);
    const existe = await sock.onWhatsApp(jid);
    jidFinal = existe?.[0]?.jid || jid;
  }
  const resp = await sock.sendMessage(jidFinal, { text: texto });
  return { jid: jidFinal, resposta: resp };
}

async function iniciarWhatsApp() {
  try {
    const { state, saveCreds } = await useSupabaseAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Reino Zap PRO', 'Chrome', '17.2']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr);
        conectado = false;
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
        if (reason !== DisconnectReason.loggedOut) setTimeout(iniciarWhatsApp, 3000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages || []) {
        try {
          if (!msg.message) continue;

          const idMsg = msg.key?.id || '';
          if (idMsg && processadas.has(idMsg)) continue;
          if (idMsg) {
            processadas.set(idMsg, Date.now());
            setTimeout(() => processadas.delete(idMsg), 10 * 60 * 1000);
          }

          const fromMe = Boolean(msg.key?.fromMe);
          const jid = msg.key?.remoteJid || '';
          const telefone = limparTelefone(jid);
          const texto = extrairTextoMensagem(msg.message);
          const comprovante = detectarComprovante(msg, texto);
          const qtd = detectarQuantidade(texto);
          const interessado = detectarInteresse(texto) || Boolean(qtd);

          ultimaMensagem = { de: jid, telefone, mensagem: texto || '[mídia]', tipo: comprovante ? 'comprovante/midia' : 'texto', interessado, quantidade: qtd, comprovante, data: new Date().toISOString() };

          if (fromMe) {
            if (detectarPdfDoAtendente(msg)) {
              await salvarContato({ telefone, status: 'finalizado', ultima_mensagem: '[PDF enviado pelo atendente]' });
              await enviarTextoDestino(jid, agradecimentoFinal());
            }
            continue;
          }

          await salvarResposta({ telefone, mensagem: texto || '[mídia/comprovante]', interessado });

          if (comprovante) {
            await salvarContato({ telefone, status: 'aguardando_dados', ultima_mensagem: texto || '[comprovante]', interessado: true, comprovante: true });
            await enviarTextoDestino(jid, respostaComprovante());
            continue;
          }

          if (qtd) {
            await salvarContato({ telefone, status: 'aguardando_pagamento', ultima_mensagem: texto, interessado: true, quantidade: qtd });
            await enviarTextoDestino(jid, respostaQuantidade(qtd));
            continue;
          }

          if (interessado) {
            await salvarContato({ telefone, status: 'interessado', ultima_mensagem: texto, interessado: true });
            await enviarTextoDestino(jid, perguntaQuantidade());
          } else {
            await salvarContato({ telefone, status: 'respondeu', ultima_mensagem: texto, interessado: false });
          }
        } catch (e) {
          console.log('Erro processando mensagem:', e.message);
        }
      }
    });
  } catch (e) {
    console.log('Erro ao iniciar WhatsApp:', e.message);
    setTimeout(iniciarWhatsApp, 5000);
  }
}

iniciarWhatsApp();

app.get('/status', (req, res) => {
  res.json({
    online: true,
    sistema: CONFIG.sistema,
    versao: CONFIG.versao,
    conectado,
    numeroConectado,
    temQr: Boolean(qrDataUrl),
    auth: SUPABASE_URL && SUPABASE_KEY ? 'supabase' : 'memoria/local',
    ultimaMensagemRecebida: ultimaMensagem,
    campanhaProgresso
  });
});

app.get('/qr', (req, res) => res.json({ conectado, numeroConectado, qr: qrDataUrl }));

app.get('/api/contatos', async (req, res) => {
  res.json({ sucesso: true, contatos: await listarContatos() });
});

app.post('/api/contatos', async (req, res) => {
  await salvarContato({ telefone: req.body.telefone, nome: req.body.nome, status: 'novo' });
  res.json({ sucesso: true });
});

app.post('/api/enviar', async (req, res) => {
  try {
    const envio = await enviarTextoDestino(req.body.telefone, req.body.mensagem);
    res.json({ sucesso: true, envio });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

app.post('/api/acao-cliente', async (req, res) => {
  try {
    const { telefone, acao } = req.body;
    if (acao === 'pix') await enviarTextoDestino(telefone, perguntaQuantidade());
    if (acao === 'dados') await enviarTextoDestino(telefone, respostaComprovante());
    if (acao === 'finalizar') {
      await salvarContato({ telefone, status: 'finalizado', ultima_mensagem: '[finalizado pelo atendente]' });
      await enviarTextoDestino(telefone, agradecimentoFinal());
    }
    res.json({ sucesso: true });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

app.post('/api/campanha', async (req, res) => {
  if (campanhaRodando) return res.status(409).json({ sucesso: false, erro: 'Campanha já está rodando' });

  campanhaRodando = true;

  const contatos = await listarContatos();
  const selecionados = Array.isArray(req.body.selecionados) ? req.body.selecionados.map(limparTelefone) : [];
  const filtro = req.body.filtro || 'todos';
  const mensagem = String(req.body.mensagem || '').trim() || '🎟️ HOJE TEM REINO DA SORTE!\n\nBilhete por apenas R$ 2,00.\n\nResponda com a quantidade que deseja comprar.';
  const limite = Number(req.body.limite || CONFIG.limitePadrao);
  const intervalo = Number(req.body.intervalo || CONFIG.intervaloPadrao);
  const agendarPara = String(req.body.agendarPara || '').trim();

  let alvo = contatos;
  if (selecionados.length) alvo = contatos.filter(c => selecionados.includes(limparTelefone(c.telefone)));
  else if (filtro !== 'todos') alvo = contatos.filter(c => (c.status || 'novo') === filtro);

  alvo = alvo.slice(0, limite);

  const registro = {
    id: Date.now(),
    nome: req.body.nome || 'Campanha',
    total: alvo.length,
    enviados: 0,
    erros: 0,
    inicio: new Date().toISOString(),
    fim: null,
    status: agendarPara ? 'agendada' : 'rodando'
  };

  memoria.campanhas.unshift(registro);
  memoria.campanhas = memoria.campanhas.slice(0, 20);

  campanhaProgresso = { total: alvo.length, enviados: 0, erros: 0, status: registro.status, inicio: registro.inicio, fim: null };

  res.json({ sucesso: true, mensagem: agendarPara ? 'Campanha agendada/iniciada no horário informado' : 'Campanha iniciada', total: alvo.length });

  async function executar() {
    campanhaProgresso.status = 'rodando';
    registro.status = 'rodando';
    for (const c of alvo) {
      try {
        await enviarTextoDestino(c.telefone, mensagem);
        campanhaProgresso.enviados++;
        registro.enviados++;
        await salvarContato({ telefone: c.telefone, status: c.status || 'novo', ultima_mensagem: mensagem });
        await delay(intervalo);
      } catch (e) {
        campanhaProgresso.erros++;
        registro.erros++;
      }
    }
    campanhaProgresso.status = 'finalizada';
    campanhaProgresso.fim = new Date().toISOString();
    registro.status = 'finalizada';
    registro.fim = campanhaProgresso.fim;
    campanhaRodando = false;
  }

  const ms = agendarPara ? Math.max(0, new Date(agendarPara).getTime() - Date.now()) : 0;
  setTimeout(executar, ms);
});

app.get('/api/campanhas', (req, res) => {
  res.json({ sucesso: true, campanhas: memoria.campanhas, progresso: campanhaProgresso });
});

function html() { return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reino Zap PRO</title><style>
*{box-sizing:border-box}body{margin:0;background:#081427;color:#fff;font-family:Arial,sans-serif}header{background:#172554;padding:24px 16px;text-align:center;border-bottom:4px solid #3b63ff}h1{font-size:32px;margin:0}main{max-width:1180px;margin:auto;padding:16px}.nav{display:flex;gap:8px;overflow-x:auto;margin:12px 0}.nav button{min-width:max-content;background:#253760}.card{background:#151c31;border:1px solid #33415f;border-radius:18px;padding:16px;margin-bottom:16px}h2{color:#aac7ff;font-size:24px;margin:0 0 14px}input,textarea,select,button{width:100%;padding:14px;border-radius:12px;border:1px solid #40506e;background:#0a1426;color:#fff;font-size:15px;margin:7px 0}textarea{min-height:115px}button{border:0;background:#4f6bed;font-weight:bold;cursor:pointer}.danger{background:#d12d37}.orange{background:#e96f23}.green{background:#22a852}.box{background:#090e1e;border-radius:12px;padding:13px;margin-top:10px;white-space:pre-wrap;overflow:auto}.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.item{background:#0a1426;border:1px solid #3a4a68;border-radius:14px;padding:12px;margin-top:10px}.tag{display:inline-block;background:#3d4d89;padding:5px 10px;border-radius:99px;font-size:12px}.ok{color:#9dff91;font-weight:bold}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.bar{height:13px;background:#071024;border-radius:99px;overflow:hidden;border:1px solid #304160}.fill{height:100%;background:#4f6bed;width:0%}.alerta{border-color:#ffcc00;box-shadow:0 0 0 2px rgba(255,204,0,.15)}@media(min-width:900px){.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.wide{grid-column:1/3}}
</style></head><body><header><h1>👑 Reino Zap PRO</h1><p>Painel profissional de vendas por WhatsApp V17.2</p></header><main>
<div class="nav"><button onclick="rolar('dash')">Dashboard</button><button onclick="rolar('camp')">Campanhas</button><button onclick="rolar('clientes')">Clientes</button><button onclick="rolar('atendimento')">Atendimento</button></div>
<div class="grid">
<section class="card" id="dash"><h2>1. WhatsApp</h2><div id="status">Carregando...</div><button onclick="atualizar()">Atualizar status</button><div id="qr"></div></section>

<section class="card"><h2>2. Envio rápido</h2><input id="telRapido" placeholder="Telefone"><textarea id="msgRapida">Teste Reino Zap ✅</textarea><button class="orange" onclick="enviarRapido()">Enviar mensagem</button><div id="retRapido" class="box"></div></section>

<section class="card wide" id="camp"><h2>3. Campanha / Oferta PRO</h2><p>Escolha uma campanha pronta ou escreva a mensagem abaixo.</p>
<select id="campPronta" onchange="usarCampanha()"><option value="">Selecione campanha pronta</option><option value="🎟️ HOJE TEM REINO DA SORTE!\\n\\nBilhete por apenas R$ 2,00.\\n\\nResponda com a quantidade que deseja comprar.">Hoje tem Reino</option><option value="🍀 Bora participar do sorteio de hoje?\\n\\n🎟️ Bilhete R$ 2,00\\nResponda só com a quantidade. Ex: 2, 5 ou 10.">Bora participar</option></select>
<div class="row"><input id="nomeCamp" placeholder="Nome da campanha"><button class="green" onclick="salvarCampanhaLocal()">Salvar campanha</button></div>
<textarea id="msgCamp">🎟️ HOJE TEM REINO DA SORTE!

Bilhete por apenas R$ 2,00.

Responda com a quantidade que deseja comprar.</textarea>
<div class="row"><input id="limite" value="20" placeholder="Limite"><input id="intervalo" value="8000" placeholder="Intervalo ms"></div>
<div class="row"><select id="filtro"><option value="todos">Todos</option><option value="novo">Novos</option><option value="respondeu">Responderam</option><option value="interessado">Interessados</option><option value="aguardando_pagamento">Aguardando pagamento</option><option value="aguardando_dados">Aguardando dados</option></select><input id="agendar" type="datetime-local"></div>
<button class="danger" onclick="campanha()">Enviar / Agendar campanha</button>
<div class="box"><b>Progresso da campanha</b><div class="bar"><div id="fill" class="fill"></div></div><div id="prog">Parado</div></div><div id="retCamp" class="box"></div></section>

<section class="card"><h2>4. Adicionar contato</h2><input id="nome" placeholder="Nome"><input id="telefone" placeholder="Telefone"><button onclick="addContato()">Salvar contato</button><div id="retContato" class="box"></div></section>

<section class="card" id="fluxo"><h2>5. Fluxo automático</h2><div class="box">Bilhete: R$ 2,00\\nPix: 88994943632\\nNome no Pix: G. DA SILVA\\n\\nCliente responde quantidade → sistema envia Pix.\\nCliente manda PDF ou imagem com texto de pagamento → sistema pede NOME e TELEFONE.\\nAtendente envia PDF → sistema agradece.\\n\\nSessão salva no Supabase.</div></section>

<section class="card wide"><h2>6. Última mensagem</h2><div id="ultima" class="box">-</div></section>

<section class="card wide"><h2>7. Últimas campanhas</h2><div id="historicoCamp"></div></section>

<section class="card wide" id="clientes"><h2>8. Clientes / Seleção</h2><button onclick="carregarClientes()">Atualizar clientes</button><div class="row"><button onclick="selecionarVisiveis()">Selecionar todos visíveis</button><button onclick="limparSelecao()">Limpar seleção</button></div><div class="kpi" id="kpis"></div><div id="lista"></div></section>

<section class="card wide" id="atendimento"><h2>9. Atendimento humanizado</h2><p>Clientes que exigem ação manual aparecem com destaque.</p><div id="manual"></div></section>
</div></main><script>
const j=x=>JSON.stringify(x,null,2);let contatos=[],selecionados=new Set(),campanhasSalvas=[];
function rolar(id){document.getElementById(id).scrollIntoView({behavior:'smooth'})}
async function api(u,o){let r=await fetch(u,o);return await r.json()}
function bip(){try{let a=new AudioContext();let o=a.createOscillator();let g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.08;o.start();setTimeout(()=>{o.stop();a.close()},250)}catch(e){}}
async function atualizar(){try{let s=await api('/status');status.innerHTML=s.conectado?'<p class="ok">WhatsApp conectado ✅<br>'+s.numeroConectado+'</p><small>Auth: '+s.auth+'</small>':'<p>WhatsApp desconectado</p>';ultima.innerText=j(s.ultimaMensagemRecebida||'-');let q=await api('/qr');qr.innerHTML=q.qr?'<img src="'+q.qr+'" style="width:100%;max-width:300px">':'Sem QR no momento.';atualizaProgresso(s.campanhaProgresso||{});await carregarCampanhas();await carregarClientes()}catch(e){status.innerHTML='Erro ao atualizar'}}
function atualizaProgresso(p){let total=p.total||0,enviados=p.enviados||0;let pct=total?Math.round((enviados/total)*100):0;fill.style.width=pct+'%';prog.innerText=(p.status||'parado')+' • '+enviados+'/'+total+' • '+pct+'% • erros: '+(p.erros||0)}
async function enviarRapido(){let r=await api('/api/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:telRapido.value,mensagem:msgRapida.value})});retRapido.innerText=j(r)}
async function addContato(){let r=await api('/api/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nome.value,telefone:telefone.value})});retContato.innerText=j(r);carregarClientes()}
function usarCampanha(){if(campPronta.value)msgCamp.value=campPronta.value.replaceAll('\\\\n','\\n')}
function salvarCampanhaLocal(){if(!nomeCamp.value.trim())return alert('Digite o nome da campanha');campanhasSalvas.push({nome:nomeCamp.value,texto:msgCamp.value});let opt=document.createElement('option');opt.value=msgCamp.value;opt.textContent=nomeCamp.value;campPronta.appendChild(opt);nomeCamp.value='';alert('Campanha salva nesta tela.')}
async function campanha(){let r=await api('/api/campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nomeCamp.value||'Campanha',mensagem:msgCamp.value,limite:limite.value,intervalo:intervalo.value,filtro:filtro.value,agendarPara:agendar.value,selecionados:[...selecionados]})});retCamp.innerText=j(r)}
async function carregarCampanhas(){let r=await api('/api/campanhas');let arr=r.campanhas||[];historicoCamp.innerHTML=arr.map(c=>'<div class="item"><b>'+c.nome+'</b><br>Status: '+c.status+'<br>Enviados: '+c.enviados+'/'+c.total+'<br>Erros: '+c.erros+'</div>').join('')||'<div class="item">Nenhuma campanha ainda</div>';atualizaProgresso(r.progresso||{})}
async function carregarClientes(){let r=await api('/api/contatos');contatos=r.contatos||[];let sts=['novo','respondeu','interessado','aguardando_pagamento','aguardando_dados','finalizado'];kpis.innerHTML=sts.map(s=>'<div class="item"><b>'+contatos.filter(c=>(c.status||'novo')===s).length+'</b><br><span class="tag">'+s+'</span></div>').join('');lista.innerHTML=contatos.map(c=>cardCliente(c)).join('');let man=contatos.filter(c=>['aguardando_dados','aguardando_finalizacao','aguardando_pagamento'].includes(c.status));manual.innerHTML=man.map(c=>cardCliente(c,true)).join('')||'<div class="item">Nenhum atendimento manual pendente</div>';if(man.length)bip()}
function cardCliente(c,manual=false){let tel=c.telefone||'';let chk=selecionados.has(tel)?'checked':'';return '<div class="item '+(manual?'alerta':'')+'"><label><input style="width:auto" type="checkbox" '+chk+' onchange="toggleSel(\\''+tel+'\\',this.checked)"> <b>'+(c.nome||'Sem nome')+'</b></label><br>'+tel+'<br><span class="tag">'+(c.status||'novo')+'</span><br>Última: '+(c.ultima_mensagem||'-')+'<div class="row"><button onclick="acao(\\''+tel+'\\',\\'pix\\')">Pix</button><button onclick="acao(\\''+tel+'\\',\\'dados\\')">Dados</button></div><button class="green" onclick="acao(\\''+tel+'\\',\\'finalizar\\')">Finalizar</button></div>'}
function toggleSel(tel,on){on?selecionados.add(tel):selecionados.delete(tel)}
function selecionarVisiveis(){contatos.forEach(c=>selecionados.add(c.telefone));carregarClientes()}
function limparSelecao(){selecionados.clear();carregarClientes()}
async function acao(tel,acao){let r=await api('/api/acao-cliente',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:tel,acao})});alert(r.sucesso?'Ação enviada':'Erro: '+r.erro);carregarClientes()}
setInterval(atualizar,10000);atualizar();
</script></body></html>`; }

app.get('/', (req, res) => res.redirect('/painel'));
app.get('/painel', (req, res) => res.send(html()));
app.listen(PORT, () => console.log('Reino Zap PRO V17.2 estável rodando na porta ' + PORT));
