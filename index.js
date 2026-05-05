import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import QRCode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let sock = null;
let qrAtual = null;
let qrDataUrl = null;
let conectado = false;
let numeroConectado = "";
let ultimaMensagemRecebida = null;
let iniciando = false;

function limparTelefone(telefone = "") {
  return String(telefone)
    .replace("@s.whatsapp.net", "")
    .replace("@c.us", "")
    .replace(/\D/g, "");
}

function detectarInteresse(mensagem = "") {
  const texto = String(mensagem).toLowerCase();
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
    "chave"
  ];
  return palavras.some((p) => texto.includes(p));
}

function extrairTextoMensagem(msg = {}) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    msg.message?.listResponseMessage?.title ||
    ""
  );
}

async function supabasePost(tabela, dados, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const { upsert = false, conflito = "" } = options;
  let url = `${SUPABASE_URL}/rest/v1/${tabela}`;

  if (upsert && conflito) {
    url += `?on_conflict=${conflito}`;
  }

  const resposta = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: upsert
        ? "resolution=merge-duplicates,return=minimal"
        : "return=minimal"
    },
    body: JSON.stringify(dados)
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Erro Supabase ${tabela}: ${erro}`);
  }
}

async function supabaseGet(tabela) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?select=*&order=id.desc`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  });

  if (!resposta.ok) return [];
  return resposta.json();
}

async function salvarMensagemRecebida({ telefone, mensagem, origem = "baileys" }) {
  const telefoneLimpo = limparTelefone(telefone);
  const textoMensagem = String(mensagem || "");
  const interessado = detectarInteresse(textoMensagem);

  await supabasePost(
    "contatos",
    {
      telefone: telefoneLimpo,
      ultima_mensagem: textoMensagem,
      interessado
    },
    { upsert: true, conflito: "telefone" }
  );

  await supabasePost("respostas", {
    telefone: telefoneLimpo,
    mensagem: textoMensagem,
    interessado
  });

  if (interessado) {
    await supabasePost("interessados", {
      telefone: telefoneLimpo,
      origem
    });
  }

  ultimaMensagemRecebida = {
    telefone: telefoneLimpo,
    mensagem: textoMensagem,
    interessado,
    data: new Date().toISOString()
  };

  return ultimaMensagemRecebida;
}

async function iniciarBaileys() {
  if (iniciando) return;
  iniciando = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_reino_zap");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Reino Zap", "Chrome", "1.0.0"],
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrAtual = qr;
        qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        conectado = false;
        numeroConectado = "";
        console.log("QR Code atualizado para conexão.");
      }

      if (connection === "open") {
        conectado = true;
        qrAtual = null;
        qrDataUrl = null;
        numeroConectado = limparTelefone(sock?.user?.id || "");
        console.log("WhatsApp conectado:", numeroConectado);
      }

      if (connection === "close") {
        conectado = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const saiu = statusCode === DisconnectReason.loggedOut;
        console.log("Conexão fechada. Status:", statusCode);

        if (!saiu) {
          setTimeout(() => {
            iniciando = false;
            iniciarBaileys();
          }, 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages || []) {
        try {
          if (!msg.message) continue;
          if (msg.key?.fromMe) continue;

          const telefone = msg.key?.remoteJid || "";
          const mensagem = extrairTextoMensagem(msg);
          if (!mensagem) continue;

          console.log("Mensagem recebida:", telefone, mensagem);
          await salvarMensagemRecebida({ telefone, mensagem, origem: "baileys" });
        } catch (erro) {
          console.log("Erro ao processar mensagem recebida:", erro.message);
        }
      }
    });
  } catch (erro) {
    console.log("Erro ao iniciar Baileys:", erro.message);
  } finally {
    iniciando = false;
  }
}

async function enviarMensagemWhatsApp(telefone, mensagem) {
  if (!sock || !conectado) {
    throw new Error("WhatsApp ainda não está conectado. Abra o painel e escaneie o QR Code.");
  }

  const numero = limparTelefone(telefone);
  if (!numero) throw new Error("Telefone inválido.");
  if (!mensagem) throw new Error("Mensagem vazia.");

  const jid = `${numero}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: String(mensagem) });

  return { sucesso: true, telefone: numero, mensagem };
}

app.get("/", (req, res) => {
  res.redirect("/painel");
});

app.get("/status", (req, res) => {
  res.json({
    online: true,
    sistema: "Reino Zap",
    versao: "10.0.0",
    motor: "baileys",
    conectado,
    numeroConectado,
    temQr: !!qrAtual,
    ultimaMensagemRecebida
  });
});

app.get("/qr", (req, res) => {
  res.json({
    conectado,
    numeroConectado,
    qr: qrAtual,
    qrDataUrl,
    ultimaMensagemRecebida
  });
});

app.post("/enviar-teste", async (req, res) => {
  try {
    const resultado = await enviarMensagemWhatsApp(req.body.telefone, req.body.mensagem);
    res.json(resultado);
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/enviar-campanha", async (req, res) => {
  try {
    const mensagem = String(req.body.mensagem || "").trim();
    const limite = Number(req.body.limite || 5);
    const intervalo = Number(req.body.intervalo || 8000);

    if (!mensagem) {
      return res.status(400).json({ sucesso: false, erro: "Mensagem obrigatória." });
    }

    const contatos = await supabaseGet("contatos");
    const lista = contatos.slice(0, limite);
    const enviados = [];
    const erros = [];

    for (const contato of lista) {
      try {
        await enviarMensagemWhatsApp(contato.telefone, mensagem);
        enviados.push(contato.telefone);
        await new Promise((resolve) => setTimeout(resolve, intervalo));
      } catch (erro) {
        erros.push({ telefone: contato.telefone, erro: erro.message });
      }
    }

    res.json({ sucesso: true, total: lista.length, enviados, erros });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/contatos", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    const nome = String(req.body.nome || "").trim();

    if (!telefone) {
      return res.status(400).json({ sucesso: false, erro: "Telefone obrigatório." });
    }

    await supabasePost(
      "contatos",
      { telefone, nome, status: "novo" },
      { upsert: true, conflito: "telefone" }
    );

    res.json({ sucesso: true, telefone, nome });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/contatos", async (req, res) => {
  const contatos = await supabaseGet("contatos");
  res.json({ sucesso: true, total: contatos.length, contatos });
});

app.get("/interessados", async (req, res) => {
  const interessados = await supabaseGet("interessados");
  res.json({ sucesso: true, total: interessados.length, interessados });
});

app.get("/painel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Reino Zap Baileys</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#0b1220;color:#fff}header{background:#142345;text-align:center;padding:28px 15px;border-bottom:4px solid #4169e1}h1{margin:0;font-size:38px}header p{font-size:20px}.wrap{padding:16px;max-width:900px;margin:auto}.card{background:#121a2f;border:1px solid #34405a;border-radius:22px;padding:20px;margin-bottom:18px}h2{color:#9ec5ff;margin-top:0}input,textarea,button{width:100%;border-radius:14px;border:1px solid #3b465f;background:#0b1220;color:#fff;padding:16px;font-size:18px;margin:8px 0}textarea{min-height:110px}button{border:0;background:#4169e1;font-weight:bold;cursor:pointer}.orange{background:#e87322}.red{background:#d3342f}.green{background:#4fa447}.msg{white-space:pre-wrap;background:#050918;color:#fff8a6;border-radius:14px;padding:14px;margin-top:12px;overflow:auto}.ok{color:#8ff0a4}.bad{color:#ff9a9a}.qrbox{text-align:center}.qrbox img{background:#fff;padding:10px;border-radius:12px;max-width:100%}.small{color:#cbd5e1;font-size:14px}.item{background:#0b1220;border:1px solid #34405a;border-radius:14px;padding:12px;margin-top:10px}
</style>
</head>
<body>
<header><h1>👑 Reino Zap</h1><p>Motor próprio WhatsApp Baileys</p></header>
<div class="wrap">
  <div class="card qrbox">
    <h2>1. Conectar WhatsApp</h2>
    <div id="status">Carregando...</div>
    <div id="qr"></div>
    <button onclick="carregarQR()">Atualizar QR/Status</button>
  </div>

  <div class="card">
    <h2>2. Envio teste</h2>
    <input id="telTeste" placeholder="Telefone: 558899999999" />
    <textarea id="msgTeste">Teste Reino Zap ✅</textarea>
    <button class="orange" onclick="enviarTeste()">Enviar teste no WhatsApp</button>
    <div id="retornoTeste" class="msg"></div>
  </div>

  <div class="card">
    <h2>3. Adicionar contato</h2>
    <input id="nomeContato" placeholder="Nome opcional" />
    <input id="telContato" placeholder="Telefone: 558899999999" />
    <button onclick="salvarContato()">Salvar contato</button>
    <div id="retornoContato" class="msg"></div>
  </div>

  <div class="card">
    <h2>4. Enviar campanha</h2>
    <textarea id="msgCampanha" placeholder="Mensagem da campanha"></textarea>
    <input id="limite" value="5" placeholder="Limite de contatos" />
    <input id="intervalo" value="8000" placeholder="Intervalo em milissegundos" />
    <button class="red" onclick="enviarCampanha()">Enviar campanha para contatos</button>
    <p class="small">Use poucos contatos no início.</p>
    <div id="retornoCampanha" class="msg"></div>
  </div>

  <div class="card">
    <h2>Última mensagem recebida</h2>
    <div id="ultima" class="msg">-</div>
  </div>

  <div class="card">
    <h2>Contatos</h2>
    <button onclick="carregarContatos()">Atualizar contatos</button>
    <div id="listaContatos"></div>
  </div>
</div>
<script>
async function api(url, options){ const r = await fetch(url, options); return await r.json(); }
function show(id,obj){ document.getElementById(id).textContent = typeof obj === 'string' ? obj : JSON.stringify(obj,null,2); }
async function carregarQR(){
  const r = await api('/qr');
  document.getElementById('status').innerHTML = r.conectado ? '<p class="ok">WhatsApp conectado ✅<br>'+ (r.numeroConectado||'') +'</p>' : '<p class="bad">WhatsApp não conectado</p>';
  document.getElementById('qr').innerHTML = r.qrDataUrl ? '<p>Escaneie no WhatsApp > Aparelhos conectados</p><img src="'+r.qrDataUrl+'" />' : '<p class="small">Sem QR no momento. Clique atualizar ou aguarde.</p>';
  show('ultima', r.ultimaMensagemRecebida || '-');
}
async function enviarTeste(){
  show('retornoTeste','Enviando...');
  const r = await api('/enviar-teste',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:document.getElementById('telTeste').value,mensagem:document.getElementById('msgTeste').value})});
  show('retornoTeste',r);
}
async function salvarContato(){
  const r = await api('/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:document.getElementById('nomeContato').value,telefone:document.getElementById('telContato').value})});
  show('retornoContato',r); carregarContatos();
}
async function enviarCampanha(){
  show('retornoCampanha','Enviando campanha...');
  const r = await api('/enviar-campanha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem:document.getElementById('msgCampanha').value,limite:document.getElementById('limite').value,intervalo:document.getElementById('intervalo').value})});
  show('retornoCampanha',r);
}
async function carregarContatos(){
  const r = await api('/contatos');
  document.getElementById('listaContatos').innerHTML = (r.contatos||[]).map(c=>'<div class="item"><b>'+(c.nome||'Sem nome')+'</b><br>'+c.telefone+'<br>Última: '+(c.ultima_mensagem||'-')+'</div>').join('') || 'Nenhum contato';
}
carregarQR(); carregarContatos(); setInterval(carregarQR, 5000);
</script>
</body>
</html>`);
});

iniciarBaileys();

app.listen(PORT, () => {
  console.log(`Reino Zap Baileys rodando na porta ${PORT}`);
});
