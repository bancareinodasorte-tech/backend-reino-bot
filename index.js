import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const BILHETE_VALOR = 2;
const PIX_CHAVE = "88994943632";
const PIX_NOME_EXIBIR = "G. DA SILVA";
const MAX_QTD_BILHETES = 500;

let sock = null;
let qrAtual = "";
let conectado = false;
let numeroConectado = "";
let ultimaMensagemRecebida = null;
let iniciando = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function limparTelefone(telefone = "") {
  return String(telefone)
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "")
    .replace("@c.us", "")
    .replace(/\D/g, "");
}

function formatarMoeda(valor) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function detectarInteresse(mensagem = "") {
  const texto = String(mensagem).toLowerCase().trim();
  if (!texto) return false;
  if (/^\d{1,4}$/.test(texto)) return true;

  const palavras = [
    "quero",
    "comprar",
    "participar",
    "pix",
    "valor",
    "manda",
    "bilhete",
    "bilhetes",
    "tenho interesse",
    "vou querer",
    "sim",
    "quanto",
    "chave",
    "preço",
    "valor",
    "pedido"
  ];

  return palavras.some((p) => texto.includes(p));
}

function extrairQuantidade(mensagem = "") {
  const texto = String(mensagem).trim();
  const somenteNumero = texto.match(/^\d{1,4}$/);
  if (somenteNumero) {
    const n = Number(texto);
    if (n > 0 && n <= MAX_QTD_BILHETES) return n;
  }

  const match = texto.match(/(?:quero|comprar|pedido|bilhetes?|vou querer|manda)\D*(\d{1,4})/i);
  if (match) {
    const n = Number(match[1]);
    if (n > 0 && n <= MAX_QTD_BILHETES) return n;
  }

  return null;
}

function respostaPerguntaQuantidade() {
  return `Perfeito! 🎟️\n\nQuantos bilhetes você deseja comprar?\n\nDigite apenas a quantidade.\nExemplo: 1, 2, 5, 10...`;
}

function respostaPedidoPix(quantidade) {
  const total = quantidade * BILHETE_VALOR;
  return `Perfeito! 🎟️\n\nVocê escolheu: ${quantidade} bilhete${quantidade > 1 ? "s" : ""}\n\n💰 Total: ${formatarMoeda(total)}\n\n📲 Pagamento via Pix:\nChave: ${PIX_CHAVE}\nNome: ${PIX_NOME_EXIBIR}\n\n⚠️ Envie o comprovante aqui para confirmar seu pedido.`;
}

function respostaComprovanteRecebido() {
  return `Recebido! ✅\n\n- Preencha os dados\nNOME:\nTELEFONE:\n\n⚠️ Aguarde o comprovante dos seus bilhetes`;
}

function ehComprovante(msg = {}, texto = "") {
  const m = msg.message || {};
  const t = String(texto || "").toLowerCase();

  return Boolean(
    m.imageMessage ||
    m.documentMessage ||
    t.includes("paguei") ||
    t.includes("comprovante") ||
    t.includes("pix feito") ||
    t.includes("já paguei") ||
    t.includes("ja paguei")
  );
}

function extrairTextoMensagem(msg = {}) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  );
}

async function supabaseRequest(method, tabela, dados = null, query = "") {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("SUPABASE_URL ou SUPABASE_KEY ausente no Render");
  }

  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}${query}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: method === "POST" ? "resolution=merge-duplicates,return=minimal" : "return=representation"
    },
    body: dados ? JSON.stringify(dados) : undefined
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Erro Supabase ${tabela}: ${erro}`);
  }

  if (method === "GET") return resposta.json();
  return true;
}

async function salvarContato({ telefone, nome = "", status = "novo", ultima_mensagem = "", interessado = false }) {
  const telefoneLimpo = limparTelefone(telefone);
  if (!telefoneLimpo) return;

  await supabaseRequest(
    "POST",
    "contatos",
    {
      telefone: telefoneLimpo,
      nome,
      status,
      ultima_mensagem,
      interessado
    },
    "?on_conflict=telefone"
  );
}

async function salvarResposta({ telefone, mensagem, interessado, origem = "whatsapp" }) {
  const telefoneLimpo = limparTelefone(telefone);
  if (!telefoneLimpo || !mensagem) return;

  await supabaseRequest("POST", "respostas", {
    telefone: telefoneLimpo,
    mensagem,
    interessado
  });

  if (interessado) {
    await supabaseRequest("POST", "interessados", {
      telefone: telefoneLimpo,
      origem
    });
  }
}

async function listarTabela(tabela) {
  return supabaseRequest("GET", tabela, null, "?select=*&order=id.desc");
}

async function enviarWhatsApp(numero, texto) {
  if (!sock || !conectado) throw new Error("WhatsApp não conectado");

  const numeroLimpo = limparTelefone(numero);
  if (!numeroLimpo) throw new Error("Telefone inválido");

  const candidatos = [];
  candidatos.push(`${numeroLimpo}@s.whatsapp.net`);

  if (numeroLimpo.startsWith("55") && numeroLimpo.length === 13 && numeroLimpo[4] === "9") {
    const semNono = `${numeroLimpo.slice(0, 4)}${numeroLimpo.slice(5)}`;
    candidatos.push(`${semNono}@s.whatsapp.net`);
  }

  if (numeroLimpo.startsWith("55") && numeroLimpo.length === 12) {
    const comNono = `${numeroLimpo.slice(0, 4)}9${numeroLimpo.slice(4)}`;
    candidatos.push(`${comNono}@s.whatsapp.net`);
  }

  let ultimoErro = null;
  const diagnostico = [];

  for (const jid of [...new Set(candidatos)]) {
    try {
      const existe = await sock.onWhatsApp(jid);
      diagnostico.push({ jid, existe });

      if (!existe?.[0]?.exists) continue;

      const envio = await sock.sendMessage(jid, { text: texto });
      return {
        sucesso: true,
        numeroOriginal: numero,
        numeroUsado: numeroLimpo,
        jid,
        texto,
        envio,
        diagnostico
      };
    } catch (e) {
      ultimoErro = e;
      diagnostico.push({ jid, erro: e.message });
    }
  }

  throw new Error(`Não foi possível enviar. ${ultimoErro?.message || "Número não encontrado no WhatsApp"}`);
}

async function processarMensagemRecebida(msg) {
  try {
    if (!msg?.message) return;
    if (msg.key?.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith("@g.us")) return;

    const texto = extrairTextoMensagem(msg).trim();
    if (!texto) return;

    const telefone = limparTelefone(jid);
    const interessado = detectarInteresse(texto);
    const quantidade = extrairQuantidade(texto);
    const comprovante = ehComprovante(msg, texto);

    ultimaMensagemRecebida = {
      de: jid,
      telefone,
      mensagem: texto || (comprovante ? "comprovante recebido" : ""),
      interessado,
      quantidade,
      comprovante,
      data: new Date().toISOString()
    };

    await salvarContato({
      telefone,
      ultima_mensagem: texto || (comprovante ? "comprovante recebido" : ""),
      interessado: interessado || comprovante,
      status: comprovante ? "aguardando_dados" : interessado ? "respondeu" : "novo"
    });

    await salvarResposta({ telefone, mensagem: texto || (comprovante ? "comprovante recebido" : ""), interessado: interessado || comprovante, origem: "whatsapp" });

    if (comprovante) {
      await delay(1200);
      await enviarWhatsApp(telefone, respostaComprovanteRecebido());
    } else if (quantidade) {
      await delay(1200);
      await enviarWhatsApp(telefone, respostaPedidoPix(quantidade));
    } else if (interessado) {
      await delay(1200);
      await enviarWhatsApp(telefone, respostaPerguntaQuantidade());
    }
  } catch (erro) {
    console.log("Erro ao processar mensagem recebida:", erro.message);
  }
}

async function iniciarBaileys() {
  if (iniciando) return;
  iniciando = true;

  try {
    const authDir = path.join(process.cwd(), "auth_info_baileys");
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Reino Zap", "Chrome", "12.0.0"],
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrAtual = await QRCode.toDataURL(qr);
        conectado = false;
        numeroConectado = "";
      }

      if (connection === "open") {
        conectado = true;
        qrAtual = "";
        numeroConectado = sock.user?.id || "";
        console.log("WhatsApp conectado:", numeroConectado);
      }

      if (connection === "close") {
        conectado = false;
        numeroConectado = "";
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const deveReconectar = statusCode !== DisconnectReason.loggedOut;
        console.log("Conexão fechada. Reconectar:", deveReconectar, "status:", statusCode);
        if (deveReconectar) {
          iniciando = false;
          setTimeout(iniciarBaileys, 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages || []) {
        await processarMensagemRecebida(msg);
      }
    });
  } catch (erro) {
    console.log("Erro ao iniciar Baileys:", erro.message);
  } finally {
    iniciando = false;
  }
}

iniciarBaileys();

app.get("/", (req, res) => res.redirect("/painel"));

app.get("/status", (req, res) => {
  res.json({
    online: true,
    sistema: "Reino Zap",
    versao: "13.1.0",
    motor: "baileys",
    conectado,
    numeroConectado,
    temQr: Boolean(qrAtual),
    ultimaMensagemRecebida,
    valorBilhete: BILHETE_VALOR,
    pix: {
      chave: PIX_CHAVE,
      nomeExibido: PIX_NOME_EXIBIR
    }
  });
});

app.get("/qr", async (req, res) => {
  if (!sock) await iniciarBaileys();
  res.json({ conectado, numeroConectado, qr: qrAtual });
});

app.post("/enviar-teste", async (req, res) => {
  try {
    const telefone = req.body.telefone;
    const mensagem = req.body.mensagem || "Teste Reino Zap ✅";
    const envio = await enviarWhatsApp(telefone, mensagem);
    res.json({ sucesso: true, telefone, mensagem, envio });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/contatos", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    const nome = req.body.nome || "";
    if (!telefone) return res.status(400).json({ sucesso: false, erro: "Telefone obrigatório" });

    await salvarContato({ telefone, nome, status: "novo" });
    res.json({ sucesso: true, telefone, nome });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/contatos", async (req, res) => {
  try {
    const contatos = await listarTabela("contatos");
    res.json({ sucesso: true, total: contatos.length, contatos });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/interessados", async (req, res) => {
  try {
    const interessados = await listarTabela("interessados");
    res.json({ sucesso: true, total: interessados.length, interessados });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/campanhas", async (req, res) => {
  try {
    const mensagem = String(req.body.mensagem || "").trim();
    if (!mensagem) return res.status(400).json({ sucesso: false, erro: "Mensagem obrigatória" });

    await supabaseRequest("POST", "campanhas", { mensagem, status: "pendente", enviados: 0 });
    res.json({ sucesso: true });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/campanhas", async (req, res) => {
  try {
    const campanhas = await listarTabela("campanhas");
    res.json({ sucesso: true, total: campanhas.length, campanhas });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/enviar-campanha", async (req, res) => {
  try {
    const mensagem = String(req.body.mensagem || "").trim();
    const limite = Math.min(Number(req.body.limite || 5), 500);
    const intervalo = Math.max(Number(req.body.intervalo || 8000), 3000);

    if (!mensagem) return res.status(400).json({ sucesso: false, erro: "Mensagem obrigatória" });

    const contatos = await listarTabela("contatos");
    const lista = contatos.slice(0, limite);
    const resultados = [];

    for (const contato of lista) {
      try {
        const envio = await enviarWhatsApp(contato.telefone, mensagem);
        resultados.push({ telefone: contato.telefone, sucesso: true, jid: envio.jid });
        await delay(intervalo);
      } catch (erro) {
        resultados.push({ telefone: contato.telefone, sucesso: false, erro: erro.message });
      }
    }

    res.json({ sucesso: true, total: resultados.length, resultados });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/painel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Reino Zap</title>
<style>
*{box-sizing:border-box} body{margin:0;font-family:Arial,sans-serif;background:#071326;color:#fff} header{background:#142957;padding:24px;text-align:center;border-bottom:4px solid #3568ff} h1{margin:0;font-size:36px} h2{color:#9ec5ff} main{padding:14px;max-width:720px;margin:auto}.card{background:#101b34;border:1px solid #34405c;border-radius:18px;padding:18px;margin-bottom:16px} input,textarea,button{width:100%;padding:15px;border-radius:12px;border:1px solid #40506f;background:#071326;color:white;font-size:16px;margin:8px 0} textarea{min-height:105px}button{background:#4169e1;border:0;font-weight:bold}.orange{background:#ff6b1a}.red{background:#ef2633}.green{background:#54a347}.box{background:#050a18;padding:14px;border-radius:12px;white-space:pre-wrap;overflow:auto;color:#fff4a8}.ok{color:#7cff9a}.small{font-size:13px;color:#c9d4ea}.item{background:#071326;border:1px solid #34405c;border-radius:12px;padding:12px;margin-top:10px} img.qr{max-width:260px;width:100%;display:block;margin:10px auto;background:#fff;padding:10px;border-radius:12px}
</style>
</head>
<body>
<header><h1>👑 Reino Zap</h1><p>Motor próprio WhatsApp Baileys V13.1</p></header>
<main>
<div class="card"><h2>1. Conectar WhatsApp</h2><div id="statusZap">Carregando...</div><div id="qrBox"></div><button onclick="carregarQr()">Atualizar QR/Status</button></div>
<div class="card"><h2>2. Envio teste</h2><input id="telTeste" value="5587991411939"><textarea id="msgTeste">Teste Reino Zap ✅</textarea><button class="orange" onclick="enviarTeste()">Enviar teste no WhatsApp</button><div id="retTeste" class="box"></div></div>
<div class="card"><h2>3. Fluxo automático</h2><p class="small">Quando o cliente responder qualquer interesse, o sistema pergunta quantos bilhetes quer. Se responder número, calcula valor e envia Pix.</p><div class="box">Bilhete: R$ 2,00\nPix: 88994943632\nNome no Pix: G. DA SILVA</div></div>
<div class="card"><h2>4. Adicionar contato</h2><input id="nomeContato" placeholder="Nome opcional"><input id="telContato" placeholder="Telefone"><button onclick="salvarContato()">Salvar contato</button><div id="retContato" class="box"></div></div>
<div class="card"><h2>5. Campanha</h2><textarea id="msgCampanha" placeholder="Mensagem da campanha"></textarea><input id="limite" value="5"><input id="intervalo" value="8000"><button class="red" onclick="enviarCampanha()">Enviar campanha</button><div id="retCampanha" class="box"></div></div>
<div class="card"><h2>Última mensagem recebida</h2><div id="ultima" class="box">-</div></div>
<div class="card"><h2>Contatos</h2><button onclick="carregarContatos()">Atualizar contatos</button><div id="listaContatos"></div></div>
</main>
<script>
async function api(url,opt){const r=await fetch(url,opt);return await r.json()}
function show(id,obj){document.getElementById(id).textContent=typeof obj==='string'?obj:JSON.stringify(obj,null,2)}
async function carregarQr(){const r=await api('/qr');document.getElementById('statusZap').innerHTML=r.conectado?'<p class="ok">WhatsApp conectado ✅<br>'+r.numeroConectado+'</p>':'<p>Aguardando QR...</p>';document.getElementById('qrBox').innerHTML=r.qr?'<img class="qr" src="'+r.qr+'">':'<p class="small">Sem QR no momento.</p>';const s=await api('/status');show('ultima',s.ultimaMensagemRecebida||'-')}
async function enviarTeste(){show('retTeste','Enviando...');const r=await api('/enviar-teste',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:telTeste.value,mensagem:msgTeste.value})});show('retTeste',r)}
async function salvarContato(){const r=await api('/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:nomeContato.value,telefone:telContato.value})});show('retContato',r);carregarContatos()}
async function enviarCampanha(){show('retCampanha','Enviando...');const r=await api('/enviar-campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem:msgCampanha.value,limite:limite.value,intervalo:intervalo.value})});show('retCampanha',r)}
async function carregarContatos(){const r=await api('/contatos');document.getElementById('listaContatos').innerHTML=(r.contatos||[]).map(c=>'<div class="item"><b>'+(c.nome||'Sem nome')+'</b><br>'+c.telefone+'<br>Última: '+(c.ultima_mensagem||'-')+'</div>').join('')||'Nenhum contato'}
carregarQr();carregarContatos();setInterval(carregarQr,10000);
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Reino Zap V13.1 rodando na porta ${PORT}`);
});
