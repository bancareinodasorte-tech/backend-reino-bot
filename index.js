import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import QRCode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let sock = null;
let conectado = false;
let numeroConectado = "";
let qrAtual = "";
let qrImagem = "";
let ultimaMensagemRecebida = null;
let ultimoEnvio = null;
let inicializando = false;

function limparTelefone(telefone = "") {
  return String(telefone).replace(/\D/g, "");
}

function candidatosBrasil(numero) {
  const n = limparTelefone(numero);
  const lista = new Set();
  if (!n) return [];
  lista.add(n);
  if (n.startsWith("55")) {
    const ddd = n.slice(2, 4);
    const resto = n.slice(4);
    if (resto.length === 8) lista.add(`55${ddd}9${resto}`);
    if (resto.length === 9 && resto.startsWith("9")) lista.add(`55${ddd}${resto.slice(1)}`);
  }
  return [...lista];
}

function detectarInteresse(mensagem = "") {
  const texto = String(mensagem).toLowerCase();
  const palavras = ["quero", "comprar", "participar", "pix", "valor", "manda", "bilhete", "bilhetes", "tenho interesse", "vou querer", "sim", "quanto", "chave"];
  return palavras.some((p) => texto.includes(p));
}

async function supabasePost(tabela, dados, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const { upsert = false, conflito = "" } = options;
  let url = `${SUPABASE_URL}/rest/v1/${tabela}`;
  if (upsert && conflito) url += `?on_conflict=${conflito}`;
  const resposta = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: upsert ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
    },
    body: JSON.stringify(dados),
  });
  if (!resposta.ok) throw new Error(await resposta.text());
}

async function supabaseGet(tabela) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?select=*&order=id.desc`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!resposta.ok) throw new Error(await resposta.text());
  return resposta.json();
}

async function salvarMensagem({ telefone, mensagem, origem }) {
  const tel = limparTelefone(telefone);
  const texto = String(mensagem || "");
  const interessado = detectarInteresse(texto);
  await supabasePost("contatos", { telefone: tel, ultima_mensagem: texto, interessado }, { upsert: true, conflito: "telefone" });
  await supabasePost("respostas", { telefone: tel, mensagem: texto, interessado });
  if (interessado) await supabasePost("interessados", { telefone: tel, origem });
  return { telefone: tel, mensagem: texto, interessado };
}

async function iniciarWhatsApp() {
  if (inicializando) return;
  inicializando = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_reino_zap");
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Reino Zap", "Chrome", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrAtual = qr;
        qrImagem = await QRCode.toDataURL(qr);
        conectado = false;
        numeroConectado = "";
      }
      if (connection === "open") {
        conectado = true;
        qrAtual = "";
        qrImagem = "";
        numeroConectado = sock?.user?.id || "";
      }
      if (connection === "close") {
        conectado = false;
        numeroConectado = "";
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => iniciarWhatsApp(), 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages || []) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || "";
        const texto = msg.message.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
        ultimaMensagemRecebida = { de: jid, mensagem: texto, data: new Date().toISOString() };
        if (texto) {
          try { await salvarMensagem({ telefone: jid, mensagem: texto, origem: "baileys" }); } catch (e) { console.log("Erro ao salvar recebida:", e.message); }
        }
      }
    });
  } catch (e) {
    console.log("Erro iniciar WhatsApp:", e.message);
  } finally {
    inicializando = false;
  }
}

async function resolverJid(numero) {
  const tentativas = candidatosBrasil(numero);
  const diagnostico = [];
  for (const n of tentativas) {
    const jid = `${n}@s.whatsapp.net`;
    try {
      const existe = await sock.onWhatsApp(n);
      diagnostico.push({ numero: n, jid, onWhatsApp: existe });
      if (Array.isArray(existe) && existe[0]?.exists) return { jid: existe[0].jid || jid, numero: n, diagnostico };
    } catch (e) {
      diagnostico.push({ numero: n, jid, erro: e.message });
    }
  }
  return { jid: `${tentativas[0] || limparTelefone(numero)}@s.whatsapp.net`, numero: tentativas[0] || limparTelefone(numero), diagnostico };
}

async function enviarMensagem(numero, texto) {
  if (!sock || !conectado) throw new Error("WhatsApp não conectado");
  const resolvido = await resolverJid(numero);
  const resposta = await sock.sendMessage(resolvido.jid, { text: texto });
  ultimoEnvio = { numeroOriginal: numero, numeroUsado: resolvido.numero, jid: resolvido.jid, texto, resposta, diagnostico: resolvido.diagnostico, data: new Date().toISOString() };
  return ultimoEnvio;
}

app.get("/", (req, res) => res.redirect("/painel"));

app.get("/status", (req, res) => {
  res.json({ online: true, sistema: "Reino Zap", versao: "11.0.0", motor: "baileys", conectado, numeroConectado, temQr: !!qrImagem, ultimaMensagemRecebida, ultimoEnvio });
});

app.get("/qr", (req, res) => res.json({ conectado, numeroConectado, qrImagem, temQr: !!qrImagem }));

app.post("/enviar-teste", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    const mensagem = String(req.body.mensagem || "Teste Reino Zap ✅");
    const envio = await enviarMensagem(telefone, mensagem);
    res.json({ sucesso: true, telefone, mensagem, envio });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message, ultimoEnvio });
  }
});

app.post("/contatos", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    const nome = req.body.nome || "";
    if (!telefone) return res.status(400).json({ sucesso: false, erro: "Telefone obrigatório" });
    await supabasePost("contatos", { telefone, nome, status: "novo" }, { upsert: true, conflito: "telefone" });
    res.json({ sucesso: true, telefone, nome });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.get("/contatos", async (req, res) => {
  try { const contatos = await supabaseGet("contatos"); res.json({ sucesso: true, total: contatos.length, contatos }); }
  catch(e){ res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.post("/enviar-campanha", async (req, res) => {
  try {
    const mensagem = String(req.body.mensagem || "").trim();
    const limite = Math.max(1, Number(req.body.limite || 5));
    const intervalo = Math.max(3000, Number(req.body.intervalo || 8000));
    if (!mensagem) return res.status(400).json({ sucesso: false, erro: "Mensagem obrigatória" });
    const contatos = (await supabaseGet("contatos")).slice(0, limite);
    const resultados = [];
    for (const c of contatos) {
      try {
        const envio = await enviarMensagem(c.telefone, mensagem);
        resultados.push({ telefone: c.telefone, sucesso: true, jid: envio.jid });
      } catch (e) {
        resultados.push({ telefone: c.telefone, sucesso: false, erro: e.message });
      }
      await new Promise(r => setTimeout(r, intervalo));
    }
    res.json({ sucesso: true, total: resultados.length, resultados });
  } catch(e){ res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.get("/painel", (req, res) => {
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reino Zap</title><style>*{box-sizing:border-box}body{margin:0;background:#08162d;color:#fff;font-family:Arial,sans-serif}header{background:#102752;text-align:center;padding:24px;border-bottom:4px solid #2f65f5}main{max-width:760px;margin:auto;padding:14px}.card{background:#101d36;border:1px solid #33415f;border-radius:18px;padding:18px;margin:14px 0}h1{margin:0;font-size:34px}h2{color:#9bc5ff}input,textarea,button{width:100%;padding:15px;margin:8px 0;border-radius:14px;border:1px solid #435270;background:#071126;color:#fff;font-size:16px}textarea{min-height:100px}button{border:0;background:#3867e8;font-weight:bold}.orange{background:#ff711f}.red{background:#e6282f}.ok{color:#7cff9d}.erro{color:#ffb4b4}pre{background:#030817;color:#ffef98;padding:14px;border-radius:14px;white-space:pre-wrap;overflow:auto}.qr{background:white;padding:10px;border-radius:14px;max-width:280px;width:100%}</style></head><body><header><h1>👑 Reino Zap</h1><p>Motor próprio WhatsApp Baileys V11</p></header><main><div class="card"><h2>1. Conectar WhatsApp</h2><div id="status">Carregando...</div><button onclick="carregarQr()">Atualizar QR/Status</button></div><div class="card"><h2>2. Envio teste</h2><input id="tel" value="5587991411939"><textarea id="msg">Teste Reino Zap ✅</textarea><button class="orange" onclick="enviarTeste()">Enviar teste no WhatsApp</button><pre id="retornoTeste"></pre></div><div class="card"><h2>3. Adicionar contato</h2><input id="nome" placeholder="Nome opcional"><input id="fone" placeholder="Telefone"><button onclick="salvarContato()">Salvar contato</button><pre id="retornoContato"></pre></div><div class="card"><h2>4. Campanha</h2><textarea id="campanha" placeholder="Mensagem da campanha"></textarea><input id="limite" value="5"><input id="intervalo" value="8000"><button class="red" onclick="enviarCampanha()">Enviar campanha</button><pre id="retornoCampanha"></pre></div><div class="card"><h2>Última mensagem recebida</h2><pre id="ultima">-</pre></div><div class="card"><h2>Contatos</h2><button onclick="carregarContatos()">Atualizar contatos</button><div id="lista"></div></div></main><script>async function api(u,o){const r=await fetch(u,o);return await r.json()}function show(id,d){document.getElementById(id).textContent=JSON.stringify(d,null,2)}async function carregarQr(){const q=await api('/qr');let html='';if(q.conectado){html='<p class="ok">WhatsApp conectado ✅<br>'+q.numeroConectado+'</p>'}else if(q.qrImagem){html='<p>Escaneie o QR:</p><img class="qr" src="'+q.qrImagem+'">'}else{html='<p>Aguardando QR. Clique atualizar em alguns segundos.</p>'}document.getElementById('status').innerHTML=html;const st=await api('/status');show('ultima',st.ultimaMensagemRecebida||'-')}async function enviarTeste(){show('retornoTeste',{enviando:true});const r=await api('/enviar-teste',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:tel.value,mensagem:msg.value})});show('retornoTeste',r)}async function salvarContato(){const r=await api('/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:fone.value,nome:nome.value})});show('retornoContato',r);carregarContatos()}async function enviarCampanha(){show('retornoCampanha',{enviando:true});const r=await api('/enviar-campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem:campanha.value,limite:limite.value,intervalo:intervalo.value})});show('retornoCampanha',r)}async function carregarContatos(){const r=await api('/contatos');document.getElementById('lista').innerHTML=(r.contatos||[]).map(c=>'<div style="background:#071126;border:1px solid #435270;border-radius:12px;padding:10px;margin:8px 0"><b>'+(c.nome||'Sem nome')+'</b><br>'+c.telefone+'<br>Última: '+(c.ultima_mensagem||'-')+'</div>').join('')||'Nenhum'}carregarQr();carregarContatos();setInterval(carregarQr,5000)</script></body></html>`);
});

app.listen(PORT, () => {
  console.log(`Reino Zap Baileys V11 rodando na porta ${PORT}`);
  iniciarWhatsApp();
});
