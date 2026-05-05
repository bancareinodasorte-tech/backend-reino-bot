import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const EVOLUTION_URL = process.env.EVOLUTION_URL || "https://evolution-api-production-db99.up.railway.app";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "reino4";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "2FFDDECB0586-4E9A-8C8C-EFC332EC4F24";

const DEFAULT_DELAY_MS = 3500;
const MAX_ENVIO_POR_CHAMADA = 20;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function htmlEscape(valor = "") {
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function validarAmbiente() {
  const faltando = [];
  if (!SUPABASE_URL) faltando.push("SUPABASE_URL");
  if (!SUPABASE_KEY) faltando.push("SUPABASE_KEY");
  if (!EVOLUTION_URL) faltando.push("EVOLUTION_URL");
  if (!EVOLUTION_INSTANCE) faltando.push("EVOLUTION_INSTANCE");
  if (!EVOLUTION_API_KEY) faltando.push("EVOLUTION_API_KEY");
  return faltando;
}

async function supabaseRequest(path, options = {}) {
  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(options.headers || {})
    }
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Erro Supabase ${path}: ${erro}`);
  }

  const texto = await resposta.text();
  if (!texto) return null;

  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

async function supabaseGet(tabela, query = "select=*&order=id.desc") {
  return supabaseRequest(`${tabela}?${query}`, { method: "GET" });
}

async function supabasePost(tabela, dados, options = {}) {
  const { upsert = false, conflito = "" } = options;
  let path = tabela;

  if (upsert && conflito) {
    path += `?on_conflict=${conflito}`;
  }

  return supabaseRequest(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: upsert ? "resolution=merge-duplicates,return=minimal" : "return=minimal"
    },
    body: JSON.stringify(dados)
  });
}

async function supabasePatch(tabela, id, dados) {
  return supabaseRequest(`${tabela}?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(dados)
  });
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

  return { telefone: telefoneLimpo, mensagem: textoMensagem, interessado };
}

async function enviarTextoWhatsApp(numero, texto) {
  const telefone = limparTelefone(numero);

  if (!telefone) {
    throw new Error("Telefone inválido para envio");
  }

  const endpoints = [
    {
      nome: "sendText oficial v2",
      url: `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      body: {
        number: telefone,
        textMessage: {
          text: texto
        }
      }
    },
    {
      nome: "sendText alternativo texto direto",
      url: `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      body: {
        number: telefone,
        text: texto
      }
    }
  ];

  const tentativas = [];

  for (const endpoint of endpoints) {
    const resposta = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_API_KEY
      },
      body: JSON.stringify(endpoint.body)
    });

    const retornoTexto = await resposta.text();
    let retorno;

    try {
      retorno = JSON.parse(retornoTexto);
    } catch {
      retorno = retornoTexto;
    }

    tentativas.push({
      endpoint: endpoint.nome,
      status: resposta.status,
      ok: resposta.ok,
      retorno
    });

    if (resposta.ok) {
      return {
        sucesso: true,
        telefone,
        endpoint: endpoint.nome,
        retorno,
        tentativas
      };
    }
  }

  return {
    sucesso: false,
    telefone,
    erro: "Nenhum endpoint de envio funcionou",
    tentativas
  };
}

function painelHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reino Zap</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#071426;color:#fff}
    header{padding:18px 14px;background:#0b1f3d;border-bottom:3px solid #1d4ed8;text-align:center;position:sticky;top:0;z-index:10}
    h1{margin:0;font-size:24px} p{line-height:1.4}
    main{padding:14px;max-width:980px;margin:auto}
    .grid{display:grid;grid-template-columns:1fr;gap:14px}
    .card{background:#111827;border:1px solid #334155;border-radius:16px;padding:15px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
    h2{margin:0 0 12px;color:#93c5fd;font-size:18px}
    input,textarea,select,button{width:100%;padding:13px;border-radius:12px;border:0;font-size:15px;margin-bottom:10px}
    input,textarea,select{background:#071426;color:#fff;border:1px solid #334155}
    textarea{min-height:120px;resize:vertical}
    button{background:#2563eb;color:#fff;font-weight:bold;cursor:pointer}
    button:active{transform:scale(.98)}
    .green{background:#16a34a}.orange{background:#f97316}.red{background:#dc2626}.gray{background:#475569}
    .stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px}
    .stat{background:#172554;border-radius:14px;text-align:center;padding:12px}.stat b{font-size:22px;display:block}.stat span{font-size:12px;color:#cbd5e1}
    .item{background:#071426;border:1px solid #334155;border-radius:12px;padding:11px;margin-bottom:9px;font-size:14px;word-break:break-word}
    .ok{color:#86efac;font-weight:bold}.erro{color:#fca5a5;font-weight:bold}.aviso{color:#fde68a;font-weight:bold}
    .mini{font-size:12px;color:#cbd5e1}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    @media(min-width:780px){.grid{grid-template-columns:1fr 1fr}.full{grid-column:1 / -1}}
  </style>
</head>
<body>
<header>
  <h1>👑 Reino Zap</h1>
  <p>Painel de envio de ofertas pelo WhatsApp</p>
</header>
<main>
  <div class="stats">
    <div class="stat"><b id="totalContatos">0</b><span>Contatos</span></div>
    <div class="stat"><b id="totalCampanhas">0</b><span>Campanhas</span></div>
    <div class="stat"><b id="totalInteressados">0</b><span>Interessados</span></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>1. Adicionar contato</h2>
      <input id="nomeContato" placeholder="Nome opcional" />
      <input id="telefoneContato" placeholder="Telefone com DDD. Ex: 558899999999" />
      <button onclick="salvarContato()">Salvar contato</button>
      <div id="msgContato"></div>
    </div>

    <div class="card">
      <h2>2. Criar campanha</h2>
      <textarea id="mensagemCampanha" placeholder="Ex: Hoje tem sorteio de R$ 2.000,00 + 3 giros extras. Bilhete R$2,00. Quer participar?"></textarea>
      <button class="green" onclick="criarCampanha()">Salvar campanha</button>
      <div id="msgCampanha"></div>
    </div>

    <div class="card">
      <h2>3. Envio teste</h2>
      <input id="telefoneTeste" placeholder="Telefone teste" />
      <textarea id="mensagemTeste">Teste Reino Zap ✅</textarea>
      <button class="orange" onclick="enviarTeste()">Enviar teste no WhatsApp</button>
      <div id="msgTeste"></div>
    </div>

    <div class="card">
      <h2>4. Enviar campanha</h2>
      <select id="campanhaSelecionada"></select>
      <input id="limiteEnvio" type="number" value="5" min="1" max="20" placeholder="Limite por vez" />
      <button class="red" onclick="enviarCampanha()">Enviar campanha para contatos</button>
      <p class="mini">Por segurança, o limite máximo por clique é 20 contatos.</p>
      <div id="msgEnvio"></div>
    </div>

    <div class="card full">
      <h2>Contatos</h2>
      <button class="gray" onclick="carregarDados()">Atualizar painel</button>
      <div id="listaContatos"></div>
    </div>

    <div class="card">
      <h2>Campanhas</h2>
      <div id="listaCampanhas"></div>
    </div>

    <div class="card">
      <h2>Interessados</h2>
      <div id="listaInteressados"></div>
    </div>
  </div>
</main>
<script>
async function api(url, options){
  const r = await fetch(url, options);
  return await r.json();
}
function msg(id, texto, tipo){document.getElementById(id).innerHTML='<p class="'+tipo+'">'+texto+'</p>'}
async function salvarContato(){
  const nome=document.getElementById('nomeContato').value;
  const telefone=document.getElementById('telefoneContato').value;
  const r=await api('/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome,telefone})});
  if(r.sucesso){msg('msgContato','Contato salvo ✅','ok');document.getElementById('nomeContato').value='';document.getElementById('telefoneContato').value='';carregarDados()}else msg('msgContato',r.erro||'Erro','erro')
}
async function criarCampanha(){
  const mensagem=document.getElementById('mensagemCampanha').value;
  const r=await api('/campanhas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem})});
  if(r.sucesso){msg('msgCampanha','Campanha criada ✅','ok');document.getElementById('mensagemCampanha').value='';carregarDados()}else msg('msgCampanha',r.erro||'Erro','erro')
}
async function enviarTeste(){
  msg('msgTeste','Enviando...','aviso');
  const telefone=document.getElementById('telefoneTeste').value;
  const mensagem=document.getElementById('mensagemTeste').value;
  const r=await api('/whatsapp/enviar-teste',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone,mensagem})});
  if(r.sucesso) msg('msgTeste','Mensagem enviada ✅','ok'); else msg('msgTeste','Falhou: '+JSON.stringify(r),'erro')
}
async function enviarCampanha(){
  msg('msgEnvio','Enviando campanha... aguarde.','aviso');
  const campanhaId=document.getElementById('campanhaSelecionada').value;
  const limite=document.getElementById('limiteEnvio').value;
  const r=await api('/campanhas/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({campanhaId,limite})});
  if(r.sucesso) msg('msgEnvio','Envio concluído. Enviadas: '+r.enviadas+' / Falhas: '+r.falhas,'ok'); else msg('msgEnvio',r.erro||JSON.stringify(r),'erro');
  carregarDados();
}
async function carregarDados(){
  const contatos=await api('/contatos');
  const campanhas=await api('/campanhas');
  const interessados=await api('/interessados');
  document.getElementById('totalContatos').innerText=contatos.total||0;
  document.getElementById('totalCampanhas').innerText=campanhas.total||0;
  document.getElementById('totalInteressados').innerText=interessados.total||0;
  document.getElementById('listaContatos').innerHTML=(contatos.contatos||[]).map(c=>'<div class="item"><b>'+((c.nome||'Sem nome'))+'</b><br>Telefone: '+c.telefone+'<br>Status: '+(c.status||'-')+'<br>Última: '+(c.ultima_mensagem||'-')+'</div>').join('') || '<p>Nenhum contato.</p>';
  document.getElementById('listaCampanhas').innerHTML=(campanhas.campanhas||[]).map(c=>'<div class="item"><b>#'+c.id+' - '+c.status+'</b><br>'+c.mensagem+'<br>Enviados: '+c.enviados+'</div>').join('') || '<p>Nenhuma campanha.</p>';
  document.getElementById('listaInteressados').innerHTML=(interessados.interessados||[]).map(i=>'<div class="item"><b>'+i.telefone+'</b><br>Origem: '+(i.origem||'-')+'</div>').join('') || '<p>Nenhum interessado.</p>';
  document.getElementById('campanhaSelecionada').innerHTML=(campanhas.campanhas||[]).map(c=>'<option value="'+c.id+'">#'+c.id+' - '+String(c.mensagem).substring(0,45)+'</option>').join('') || '<option value="">Nenhuma campanha</option>';
}
carregarDados();
</script>
</body>
</html>`;
}

app.get("/", (req, res) => res.send("Backend Reino Zap V7 ONLINE 🚀"));

app.get("/status", (req, res) => {
  res.json({
    online: true,
    sistema: "Reino Zap",
    versao: "7.0.0",
    modo: "envio-whatsapp",
    evolution: {
      url: EVOLUTION_URL,
      instance: EVOLUTION_INSTANCE
    },
    ambienteFaltando: validarAmbiente()
  });
});

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
    const nome = String(req.body.nome || "").trim();
    const status = req.body.status || "novo";
    if (!telefone) return res.status(400).json({ sucesso: false, erro: "Telefone obrigatório" });
    await supabasePost("contatos", { telefone, nome, status }, { upsert: true, conflito: "telefone" });
    res.json({ sucesso: true, telefone, nome, status });
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
    res.json({ sucesso: true, mensagem: "Campanha criada" });
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

app.post("/whatsapp/enviar-teste", async (req, res) => {
  try {
    const telefone = req.body.telefone;
    const mensagem = req.body.mensagem || "Teste Reino Zap ✅";
    const resultado = await enviarTextoWhatsApp(telefone, mensagem);
    res.json(resultado);
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/campanhas/enviar", async (req, res) => {
  try {
    const campanhaId = Number(req.body.campanhaId);
    const limiteSolicitado = Math.max(1, Number(req.body.limite || 5));
    const limite = Math.min(limiteSolicitado, MAX_ENVIO_POR_CHAMADA);

    if (!campanhaId) return res.status(400).json({ sucesso: false, erro: "Campanha inválida" });

    const campanhas = await supabaseGet("campanhas", `select=*&id=eq.${campanhaId}&limit=1`);
    const campanha = campanhas[0];
    if (!campanha) return res.status(404).json({ sucesso: false, erro: "Campanha não encontrada" });

    const contatos = await supabaseGet("contatos", `select=*&order=id.asc&limit=${limite}`);
    const resultados = [];
    let enviadas = 0;
    let falhas = 0;

    await supabasePatch("campanhas", campanhaId, { status: "enviando" });

    for (const contato of contatos) {
      const resultado = await enviarTextoWhatsApp(contato.telefone, campanha.mensagem);
      resultados.push({ telefone: contato.telefone, sucesso: resultado.sucesso, retorno: resultado });
      if (resultado.sucesso) enviadas += 1;
      else falhas += 1;
      await sleep(DEFAULT_DELAY_MS);
    }

    await supabasePatch("campanhas", campanhaId, {
      status: "enviada",
      enviados: Number(campanha.enviados || 0) + enviadas
    });

    res.json({ sucesso: true, campanhaId, enviadas, falhas, resultados });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/webhook", (req, res) => res.send("Webhook mantido, mas não obrigatório nesta versão."));

app.post("/webhook", async (req, res) => {
  try {
    console.log("WEBHOOK RECEBIDO:", JSON.stringify(req.body));
    const telefone = req.body?.data?.key?.remoteJid || req.body?.sender || req.body?.number || "sem-telefone";
    const mensagem =
      req.body?.data?.message?.conversation ||
      req.body?.data?.message?.extendedTextMessage?.text ||
      req.body?.message?.conversation ||
      req.body?.message?.extendedTextMessage?.text ||
      req.body?.text ||
      "";
    const resultado = await salvarMensagem({ telefone, mensagem, origem: "webhook" });
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    console.error("Erro webhook:", erro.message);
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

app.listen(PORT, () => console.log(`Servidor Reino Zap V7 rodando na porta ${PORT} 🚀`));
