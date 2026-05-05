import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

const EVOLUTION_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "reino4";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";

const BACKEND_URL = process.env.BACKEND_URL || "https://backend-reino-bot.onrender.com";

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
    "chave",
    "me envia",
    "tenho interesse"
  ];
  return palavras.some((p) => texto.includes(p));
}

function extrairTextoMensagem(obj = {}) {
  return (
    obj?.mensagem ||
    obj?.text ||
    obj?.messageText ||
    obj?.body ||
    obj?.content ||
    obj?.message?.conversation ||
    obj?.message?.extendedTextMessage?.text ||
    obj?.message?.imageMessage?.caption ||
    obj?.message?.videoMessage?.caption ||
    obj?.data?.message?.conversation ||
    obj?.data?.message?.extendedTextMessage?.text ||
    obj?.data?.message?.imageMessage?.caption ||
    obj?.data?.message?.videoMessage?.caption ||
    obj?.data?.body ||
    ""
  );
}

function extrairTelefoneMensagem(obj = {}) {
  return (
    obj?.telefone ||
    obj?.number ||
    obj?.remoteJid ||
    obj?.key?.remoteJid ||
    obj?.data?.key?.remoteJid ||
    obj?.data?.remoteJid ||
    obj?.participant ||
    obj?.data?.participant ||
    "sem-telefone"
  );
}

function ehMensagemMinha(obj = {}) {
  return Boolean(
    obj?.fromMe ||
    obj?.key?.fromMe ||
    obj?.data?.key?.fromMe ||
    obj?.data?.fromMe
  );
}

async function supabaseGet(tabela, limite = 100) {
  const resposta = await fetch(
    `${SUPABASE_URL}/rest/v1/${tabela}?select=*&order=id.desc&limit=${limite}`,
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

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
      Prefer: upsert ? "resolution=merge-duplicates,return=minimal" : "return=minimal"
    },
    body: JSON.stringify(dados)
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Erro Supabase POST ${tabela}: ${erro}`);
  }
}

async function salvarMensagem({ telefone, mensagem, origem = "sistema" }) {
  const telefoneLimpo = limparTelefone(telefone);
  const textoMensagem = String(mensagem || "").trim();

  if (!telefoneLimpo || telefoneLimpo === "sem") {
    return { salvo: false, motivo: "telefone inválido" };
  }

  if (!textoMensagem) {
    return { salvo: false, motivo: "mensagem vazia", telefone: telefoneLimpo };
  }

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

  return {
    salvo: true,
    telefone: telefoneLimpo,
    mensagem: textoMensagem,
    interessado,
    origem
  };
}

async function evolutionRequest(path, options = {}) {
  if (!EVOLUTION_URL || !EVOLUTION_API_KEY) {
    return {
      ok: false,
      status: 0,
      erro: "EVOLUTION_URL ou EVOLUTION_API_KEY não configurada no Render"
    };
  }

  const resposta = await fetch(`${EVOLUTION_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const texto = await resposta.text();
  let json = null;

  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }

  return {
    ok: resposta.ok,
    status: resposta.status,
    path,
    json,
    texto: json ? undefined : texto
  };
}

function coletarMensagens(obj, resultado = []) {
  if (!obj) return resultado;

  if (Array.isArray(obj)) {
    for (const item of obj) coletarMensagens(item, resultado);
    return resultado;
  }

  if (typeof obj === "object") {
    const texto = extrairTextoMensagem(obj);
    const telefone = extrairTelefoneMensagem(obj);
    const temCaraDeMensagem = texto && telefone && telefone !== "sem-telefone";

    if (temCaraDeMensagem) {
      resultado.push(obj);
    }

    for (const valor of Object.values(obj)) {
      if (valor && typeof valor === "object") coletarMensagens(valor, resultado);
    }
  }

  return resultado;
}

async function buscarMensagensEvolution() {
  const tentativas = [
    {
      nome: "POST /chat/findMessages",
      path: `/chat/findMessages/${EVOLUTION_INSTANCE}`,
      method: "POST",
      body: {}
    },
    {
      nome: "POST /chat/findMessages where empty",
      path: `/chat/findMessages/${EVOLUTION_INSTANCE}`,
      method: "POST",
      body: { where: {} }
    },
    {
      nome: "GET /chat/findMessages",
      path: `/chat/findMessages/${EVOLUTION_INSTANCE}`,
      method: "GET"
    },
    {
      nome: "POST /chat/findChats",
      path: `/chat/findChats/${EVOLUTION_INSTANCE}`,
      method: "POST",
      body: {}
    },
    {
      nome: "GET /instance/fetchInstances",
      path: `/instance/fetchInstances` ,
      method: "GET"
    }
  ];

  const resultados = [];
  let mensagens = [];

  for (const tentativa of tentativas) {
    const retorno = await evolutionRequest(tentativa.path, {
      method: tentativa.method,
      body: tentativa.body
    });

    const encontradas = coletarMensagens(retorno.json || retorno.texto || []);

    resultados.push({
      nome: tentativa.nome,
      status: retorno.status,
      ok: retorno.ok,
      quantidadeEncontrada: encontradas.length,
      amostra: encontradas.slice(0, 2)
    });

    if (encontradas.length > mensagens.length) mensagens = encontradas;
  }

  return { resultados, mensagens };
}

app.get("/", (req, res) => {
  res.send("Backend Reino Zap V6 ONLINE 🚀");
});

app.get("/status", (req, res) => {
  res.json({
    online: true,
    sistema: "Reino Zap",
    versao: "6.0.0",
    evolutionConfigurada: Boolean(EVOLUTION_URL && EVOLUTION_API_KEY && EVOLUTION_INSTANCE),
    evolutionInstance: EVOLUTION_INSTANCE
  });
});

app.get("/painel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Reino Zap</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#071225;color:#fff}header{padding:18px;text-align:center;background:#0b2a55;border-bottom:3px solid #1d4ed8}main{padding:15px;max-width:1000px;margin:auto}.grid{display:grid;grid-template-columns:1fr;gap:14px}.card{background:#101827;border:1px solid #243047;border-radius:16px;padding:16px}h2{margin:0 0 12px;color:#93c5fd}input,textarea,button{width:100%;border-radius:12px;border:0;padding:13px;font-size:15px;margin-bottom:10px}input,textarea{background:#071225;color:#fff;border:1px solid #334155}button{background:#2563eb;color:#fff;font-weight:bold}.ok{color:#86efac;font-weight:bold}.erro{color:#fca5a5;font-weight:bold}.item{background:#071225;border:1px solid #334155;border-radius:12px;padding:12px;margin-top:8px;font-size:14px}.contador{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px}.box{background:#172554;border-radius:14px;padding:14px;text-align:center}.box b{font-size:22px;display:block}</style>
</head>
<body>
<header><h1>👑 Reino Zap</h1><p>Painel WhatsApp de vendas</p></header>
<main>
<div class="contador"><div class="box"><b id="tc">0</b><span>Contatos</span></div><div class="box"><b id="ti">0</b><span>Interessados</span></div><div class="box"><b id="tr">0</b><span>Respostas</span></div></div>
<div class="grid">
<div class="card"><h2>Teste Evolution</h2><button onclick="statusEvolution()">Ver status</button><button onclick="buscarMensagens()">Buscar mensagens direto</button><button onclick="sincronizar()">Sincronizar respostas</button><div id="msgEvo"></div></div>
<div class="card"><h2>Adicionar contato</h2><input id="nome" placeholder="Nome opcional"><input id="telefone" placeholder="Telefone com DDD"><button onclick="salvarContato()">Salvar contato</button><div id="msgContato"></div></div>
<div class="card"><h2>Criar campanha</h2><textarea id="campanha" placeholder="Digite a mensagem da campanha"></textarea><button onclick="criarCampanha()">Salvar campanha</button><div id="msgCampanha"></div></div>
<div class="card"><h2>Interessados</h2><button onclick="carregar()">Atualizar</button><div id="interessados"></div></div>
<div class="card"><h2>Contatos</h2><div id="contatos"></div></div>
<div class="card"><h2>Respostas</h2><div id="respostas"></div></div>
</div>
</main>
<script>
async function api(u,o){const r=await fetch(u,o);return await r.json()}
function html(id,txt,cl='ok'){document.getElementById(id).innerHTML='<p class="'+cl+'">'+txt+'</p>'}
async function carregar(){const c=await api('/contatos');const i=await api('/interessados');const r=await api('/respostas');document.getElementById('tc').innerText=c.total||0;document.getElementById('ti').innerText=i.total||0;document.getElementById('tr').innerText=r.total||0;document.getElementById('contatos').innerHTML=(c.contatos||[]).map(x=>'<div class="item"><b>'+x.telefone+'</b><br>'+(x.nome||'')+'<br>'+(x.ultima_mensagem||'')+'</div>').join('')||'Nenhum';document.getElementById('interessados').innerHTML=(i.interessados||[]).map(x=>'<div class="item"><b>'+x.telefone+'</b><br>'+x.origem+'</div>').join('')||'Nenhum';document.getElementById('respostas').innerHTML=(r.respostas||[]).map(x=>'<div class="item"><b>'+x.telefone+'</b><br>'+x.mensagem+'<br>Interessado: '+x.interessado+'</div>').join('')||'Nenhuma'}
async function salvarContato(){const r=await api('/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:document.getElementById('nome').value,telefone:document.getElementById('telefone').value})});html('msgContato',r.sucesso?'Contato salvo':r.erro,r.sucesso?'ok':'erro');carregar()}
async function criarCampanha(){const r=await api('/campanhas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem:document.getElementById('campanha').value})});html('msgCampanha',r.sucesso?'Campanha salva':r.erro,r.sucesso?'ok':'erro')}
async function statusEvolution(){const r=await api('/evolution/status');html('msgEvo','Status: '+JSON.stringify(r).slice(0,500),'ok')}
async function buscarMensagens(){const r=await api('/evolution/buscar-mensagens');html('msgEvo','Encontradas: '+(r.total||0)+'<br><small>'+JSON.stringify(r.diagnostico).slice(0,800)+'</small>','ok')}
async function sincronizar(){const r=await api('/evolution/sincronizar');html('msgEvo','Salvas: '+(r.salvas||0)+'<br><small>'+JSON.stringify(r).slice(0,800)+'</small>',r.sucesso?'ok':'erro');carregar()}
carregar();
</script>
</body></html>`);
});

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
    if (!telefone) return res.status(400).json({ sucesso: false, erro: "Telefone obrigatório" });
    await supabasePost("contatos", { telefone, nome: req.body.nome || "", status: "novo" }, { upsert: true, conflito: "telefone" });
    res.json({ sucesso: true, telefone });
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

app.get("/respostas", async (req, res) => {
  try {
    const respostas = await supabaseGet("respostas");
    res.json({ sucesso: true, total: respostas.length, respostas });
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
    if (!mensagem) return res.status(400).json({ sucesso: false, erro: "Mensagem obrigatória" });
    await supabasePost("campanhas", { mensagem, status: "pendente", enviados: 0 });
    res.json({ sucesso: true });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/teste", async (req, res) => {
  try {
    const resultado = await salvarMensagem({
      telefone: req.query.telefone || "558899999999",
      mensagem: req.query.mensagem || "quero comprar",
      origem: "teste"
    });
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK RECEBIDO:", JSON.stringify(req.body).slice(0, 2000));
    const resultado = await salvarMensagem({
      telefone: extrairTelefoneMensagem(req.body),
      mensagem: extrairTextoMensagem(req.body),
      origem: "webhook"
    });
    res.json({ sucesso: true, resultado });
  } catch (erro) {
    console.log("Erro webhook:", erro.message);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/webhook/messages-upsert", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK EVENTO MESSAGES_UPSERT:", JSON.stringify(req.body).slice(0, 2000));
    const resultado = await salvarMensagem({
      telefone: extrairTelefoneMensagem(req.body),
      mensagem: extrairTextoMensagem(req.body),
      origem: "webhook_evento"
    });
    res.json({ sucesso: true, resultado });
  } catch (erro) {
    console.log("Erro webhook event:", erro.message);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/evolution/status", async (req, res) => {
  try {
    const estado = await evolutionRequest(`/instance/connectionState/${EVOLUTION_INSTANCE}`);
    const instancias = await evolutionRequest(`/instance/fetchInstances`);
    res.json({ sucesso: true, estado, instancias });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/evolution/testar-envio", async (req, res) => {
  try {
    const numero = limparTelefone(req.query.numero || "");
    const mensagem = String(req.query.mensagem || "Teste Reino Zap ✅");
    if (!numero) return res.status(400).json({ sucesso: false, erro: "Informe ?numero=5588..." });

    const envio = await evolutionRequest(`/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: "POST",
      body: { number: numero, text: mensagem }
    });

    res.json({ sucesso: envio.ok, envio });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/evolution/buscar-mensagens", async (req, res) => {
  try {
    const busca = await buscarMensagensEvolution();
    res.json({
      sucesso: true,
      total: busca.mensagens.length,
      diagnostico: busca.resultados,
      amostra: busca.mensagens.slice(0, 5)
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/evolution/sincronizar", async (req, res) => {
  try {
    const busca = await buscarMensagensEvolution();
    const salvas = [];

    for (const msg of busca.mensagens.slice(0, 50)) {
      if (ehMensagemMinha(msg)) continue;

      const resultado = await salvarMensagem({
        telefone: extrairTelefoneMensagem(msg),
        mensagem: extrairTextoMensagem(msg),
        origem: "sincronizacao_evolution"
      });

      if (resultado.salvo) salvas.push(resultado);
    }

    res.json({
      sucesso: true,
      encontradas: busca.mensagens.length,
      salvas: salvas.length,
      mensagensSalvas: salvas,
      diagnostico: busca.resultados
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Reino Zap V6 rodando na porta ${PORT} 🚀`);
});
