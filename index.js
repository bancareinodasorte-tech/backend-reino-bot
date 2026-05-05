import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const EVOLUTION_URL = process.env.EVOLUTION_URL || "https://evolution-api-production-db99.up.railway.app";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "reino4";
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || "";

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

function limparTelefone(telefone = "") {
  return String(telefone)
    .replace("@s.whatsapp.net", "")
    .replace("@c.us", "")
    .replace(/\D/g, "");
}

function formatarNumeroWhatsApp(telefone = "") {
  const numero = limparTelefone(telefone);
  if (!numero) return "";
  return numero;
}

async function supabaseGet(tabela) {
  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?select=*&order=id.desc`, {
    method: "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Erro Supabase GET ${tabela}: ${erro}`);
  }

  return resposta.json();
}

async function supabasePost(tabela, dados, options = {}) {
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
    throw new Error(`Erro Supabase POST ${tabela}: ${erro}`);
  }
}

async function supabasePatch(tabela, id, dados) {
  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal"
    },
    body: JSON.stringify(dados)
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Erro Supabase PATCH ${tabela}: ${erro}`);
  }
}

async function salvarMensagem({ telefone, mensagem, origem }) {
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
    {
      upsert: true,
      conflito: "telefone"
    }
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

  return {
    telefone: telefoneLimpo,
    mensagem: textoMensagem,
    interessado
  };
}

async function enviarWhatsApp(telefone, mensagem) {
  if (!EVOLUTION_KEY) {
    throw new Error("EVOLUTION_KEY não configurada no Render");
  }

  const numero = formatarNumeroWhatsApp(telefone);

  if (!numero) {
    throw new Error("Telefone inválido para envio");
  }

  const resposta = await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_KEY
    },
    body: JSON.stringify({
      number: numero,
      text: mensagem
    })
  });

  const texto = await resposta.text();

  if (!resposta.ok) {
    throw new Error(`Erro Evolution API: ${texto}`);
  }

  try {
    return JSON.parse(texto);
  } catch {
    return { resposta: texto };
  }
}

function painelHtml() {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Reino Zap - Painel</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:Arial,sans-serif;background:#0b1220;color:#fff}
    header{background:#0f1f3d;padding:18px;text-align:center;border-bottom:3px solid #1d4ed8}
    header h1{margin:0;font-size:24px} header p{margin:6px 0 0;color:#cbd5e1;font-size:14px}
    main{padding:15px;max-width:1000px;margin:auto}
    .contador{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:15px}
    .box{background:#172554;border-radius:14px;padding:14px;text-align:center}.box b{font-size:22px;display:block}.box span{font-size:12px;color:#cbd5e1}
    .grid{display:grid;grid-template-columns:1fr;gap:15px}.card{background:#111827;border:1px solid #243047;border-radius:16px;padding:16px;box-shadow:0 8px 25px rgba(0,0,0,.25)}
    h2{font-size:18px;margin:0 0 12px;color:#93c5fd} input,textarea,button{width:100%;border-radius:12px;border:0;padding:13px;font-size:15px;margin-bottom:10px}
    input,textarea{background:#0b1220;color:#fff;border:1px solid #334155} textarea{min-height:110px;resize:vertical}
    button{background:#2563eb;color:white;font-weight:bold;cursor:pointer} button:active{transform:scale(.98)} .btn-green{background:#16a34a}.btn-orange{background:#f97316}.btn-red{background:#dc2626}
    .lista{display:flex;flex-direction:column;gap:10px;margin-top:10px}.item{background:#0b1220;border:1px solid #334155;border-radius:12px;padding:12px;font-size:14px;word-break:break-word}.item strong{color:#bfdbfe}
    .ok{color:#86efac;font-weight:bold}.erro{color:#fca5a5;font-weight:bold}.mini{font-size:12px;color:#cbd5e1}.linha{height:1px;background:#334155;margin:10px 0}
  </style>
</head>
<body>
  <header><h1>👑 Reino Zap</h1><p>Painel de vendas por WhatsApp</p></header>
  <main>
    <div class="contador">
      <div class="box"><b id="totalContatos">0</b><span>Contatos</span></div>
      <div class="box"><b id="totalInteressados">0</b><span>Interessados</span></div>
      <div class="box"><b id="totalCampanhas">0</b><span>Campanhas</span></div>
    </div>
    <div class="grid">
      <div class="card"><h2>Adicionar contato</h2><input id="nomeContato" placeholder="Nome do cliente (opcional)"><input id="telefoneContato" placeholder="Telefone com DDD. Ex: 558899999999"><button onclick="salvarContato()">Salvar contato</button><div id="msgContato"></div></div>
      <div class="card"><h2>Criar campanha</h2><textarea id="mensagemCampanha" placeholder="Ex: Hoje tem sorteio de R$ 2.000,00 + 3 giros de R$100,00. Quer participar?"></textarea><button class="btn-green" onclick="criarCampanha()">Salvar campanha</button><div id="msgCampanha"></div></div>
      <div class="card"><h2>Enviar mensagem manual</h2><input id="telefoneEnvio" placeholder="Telefone com DDD. Ex: 558899999999"><textarea id="mensagemEnvio" placeholder="Mensagem para enviar no WhatsApp"></textarea><button class="btn-orange" onclick="enviarManual()">Enviar WhatsApp</button><div id="msgEnvio"></div></div>
      <div class="card"><h2>Teste de interesse</h2><input id="telefoneTeste" placeholder="Telefone para teste" value="558899999999"><input id="mensagemTeste" placeholder="Mensagem" value="quero comprar"><button class="btn-orange" onclick="testarMensagem()">Testar mensagem</button><div id="msgTeste"></div></div>
      <div class="card"><h2>Interessados</h2><button onclick="carregarDados()">Atualizar lista</button><div id="listaInteressados" class="lista"></div></div>
      <div class="card"><h2>Contatos</h2><div id="listaContatos" class="lista"></div></div>
      <div class="card"><h2>Campanhas</h2><div id="listaCampanhas" class="lista"></div></div>
    </div>
  </main>
<script>
async function api(url, options){const r=await fetch(url, options);return await r.json();}
function mostrar(id,texto,tipo){document.getElementById(id).innerHTML='<p class="'+tipo+'">'+texto+'</p>';}
async function salvarContato(){const nome=document.getElementById('nomeContato').value;const telefone=document.getElementById('telefoneContato').value;const r=await api('/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome,telefone})});if(r.sucesso){mostrar('msgContato','Contato salvo com sucesso ✅','ok');document.getElementById('nomeContato').value='';document.getElementById('telefoneContato').value='';carregarDados();}else{mostrar('msgContato',r.erro,'erro');}}
async function criarCampanha(){const mensagem=document.getElementById('mensagemCampanha').value;const r=await api('/campanhas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem})});if(r.sucesso){mostrar('msgCampanha','Campanha salva com sucesso ✅','ok');document.getElementById('mensagemCampanha').value='';carregarDados();}else{mostrar('msgCampanha',r.erro,'erro');}}
async function enviarManual(){const telefone=document.getElementById('telefoneEnvio').value;const mensagem=document.getElementById('mensagemEnvio').value;const r=await api('/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone,mensagem})});if(r.sucesso){mostrar('msgEnvio','Mensagem enviada ✅','ok');document.getElementById('mensagemEnvio').value='';}else{mostrar('msgEnvio',r.erro,'erro');}}
async function testarMensagem(){const telefone=document.getElementById('telefoneTeste').value;const mensagem=encodeURIComponent(document.getElementById('mensagemTeste').value);const r=await api('/teste?telefone='+telefone+'&mensagem='+mensagem);if(r.sucesso){mostrar('msgTeste','Mensagem registrada. Interessado: '+r.interessado,'ok');carregarDados();}else{mostrar('msgTeste',r.erro,'erro');}}
async function carregarDados(){const contatos=await api('/contatos');const interessados=await api('/interessados');const campanhas=await api('/campanhas');document.getElementById('totalContatos').innerText=contatos.total||0;document.getElementById('totalInteressados').innerText=interessados.total||0;document.getElementById('totalCampanhas').innerText=campanhas.total||0;document.getElementById('listaContatos').innerHTML=(contatos.contatos||[]).map(c=>'<div class="item"><strong>'+(c.nome||'Sem nome')+'</strong><br>Telefone: '+c.telefone+'<br>Status: '+(c.status||'-')+'<br>Última: '+(c.ultima_mensagem||'-')+'</div>').join('')||'<p>Nenhum contato.</p>';document.getElementById('listaInteressados').innerHTML=(interessados.interessados||[]).map(i=>'<div class="item"><strong>'+i.telefone+'</strong><br>Origem: '+(i.origem||'-')+'</div>').join('')||'<p>Nenhum interessado.</p>';document.getElementById('listaCampanhas').innerHTML=(campanhas.campanhas||[]).map(c=>'<div class="item"><strong>Status: '+c.status+'</strong><br>'+c.mensagem+'<br>Enviados: '+c.enviados+'</div>').join('')||'<p>Nenhuma campanha.</p>';}
carregarDados();
</script>
</body>
</html>`;
}

app.get("/", (req, res) => res.send("Backend Reino Zap V2 ONLINE 🚀"));
app.get("/status", (req, res) => res.json({ online: true, sistema: "Reino Zap", versao: "2.0.0", whatsapp: EVOLUTION_INSTANCE }));
app.get("/painel", (req, res) => res.send(painelHtml()));

app.get("/contatos", async (req, res) => {
  try {
    const contatos = await supabaseGet("contatos");
    res.json({ sucesso: true, total: contatos.length, contatos });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/contatos", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    const nome = req.body.nome || "";
    const status = req.body.status || "novo";

    if (!telefone) return res.status(400).json({ sucesso: false, erro: "Telefone obrigatório" });

    await supabasePost("contatos", { telefone, nome, status }, { upsert: true, conflito: "telefone" });
    res.json({ sucesso: true, mensagem: "Contato salvo", telefone, nome, status });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/interessados", async (req, res) => {
  try {
    const interessados = await supabaseGet("interessados");
    res.json({ sucesso: true, total: interessados.length, interessados });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/campanhas", async (req, res) => {
  try {
    const campanhas = await supabaseGet("campanhas");
    res.json({ sucesso: true, total: campanhas.length, campanhas });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/campanhas", async (req, res) => {
  try {
    const mensagem = String(req.body.mensagem || "").trim();
    if (!mensagem) return res.status(400).json({ sucesso: false, erro: "Mensagem da campanha é obrigatória" });
    await supabasePost("campanhas", { mensagem, status: "pendente", enviados: 0 });
    res.json({ sucesso: true, mensagem: "Campanha criada" });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/enviar", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    const mensagem = String(req.body.mensagem || "").trim();

    if (!telefone) return res.status(400).json({ sucesso: false, erro: "Telefone obrigatório" });
    if (!mensagem) return res.status(400).json({ sucesso: false, erro: "Mensagem obrigatória" });

    const envio = await enviarWhatsApp(telefone, mensagem);

    await supabasePost("respostas", { telefone, mensagem: `[ENVIADA] ${mensagem}`, interessado: false });
    await supabasePost("contatos", { telefone, ultima_mensagem: `[ENVIADA] ${mensagem}` }, { upsert: true, conflito: "telefone" });

    res.json({ sucesso: true, telefone, envio });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/webhook", (req, res) => res.send("Webhook ativo ✅ Use POST para receber mensagens do WhatsApp."));

app.get("/teste", async (req, res) => {
  try {
    const resultado = await salvarMensagem({ telefone: req.query.telefone || "558899999999", mensagem: req.query.mensagem || "quero participar", origem: "teste" });
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const telefone = req.body.telefone || req.body.number || req.body.remoteJid || req.body?.data?.key?.remoteJid || req.body?.key?.remoteJid || "sem-telefone";
    const mensagem = req.body.mensagem || req.body.text || req.body.message || req.body?.data?.message?.conversation || req.body?.data?.message?.extendedTextMessage?.text || req.body?.message?.conversation || req.body?.message?.extendedTextMessage?.text || "";
    const resultado = await salvarMensagem({ telefone, mensagem, origem: "whatsapp" });
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    console.error("Erro no webhook:", erro.message);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.listen(PORT, () => console.log(`Servidor Reino Zap rodando na porta ${PORT} 🚀`));
