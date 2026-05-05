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
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "2FFDDECB0586-4E9A-8C8C-EFC332EC4F24";

function limparTelefone(telefone = "") {
  return String(telefone)
    .replace("@s.whatsapp.net", "")
    .replace("@c.us", "")
    .replace(/^\+/, "")
    .replace(/\D/g, "");
}

function detectarInteresse(mensagem = "") {
  const texto = String(mensagem).toLowerCase();
  const palavras = ["quero", "comprar", "participar", "pix", "valor", "manda", "bilhete", "bilhetes", "tenho interesse", "vou querer", "sim", "quanto", "chave"];
  return palavras.some((p) => texto.includes(p));
}

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchComTimeout(url, options = {}, timeoutMs = 35000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resposta = await fetch(url, { ...options, signal: controller.signal });
    const texto = await resposta.text();
    let data;
    try { data = texto ? JSON.parse(texto) : null; } catch { data = texto; }
    return { ok: resposta.ok, status: resposta.status, data };
  } catch (erro) {
    return { ok: false, status: 0, data: { erro: erro.name === "AbortError" ? "timeout" : erro.message } };
  } finally {
    clearTimeout(timer);
  }
}

async function supabaseGet(tabela) {
  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?select=*&order=id.desc`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!resposta.ok) throw new Error(`Erro Supabase GET ${tabela}: ${await resposta.text()}`);
  return resposta.json();
}

async function supabasePost(tabela, dados, options = {}) {
  const { upsert = false, conflito = "" } = options;
  let url = `${SUPABASE_URL}/rest/v1/${tabela}`;
  if (upsert && conflito) url += `?on_conflict=${conflito}`;
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
  if (!resposta.ok) throw new Error(`Erro Supabase POST ${tabela}: ${await resposta.text()}`);
}

async function salvarMensagem({ telefone, mensagem, origem }) {
  const telefoneLimpo = limparTelefone(telefone);
  const textoMensagem = String(mensagem || "");
  const interessado = detectarInteresse(textoMensagem);

  await supabasePost("contatos", { telefone: telefoneLimpo, ultima_mensagem: textoMensagem, interessado }, { upsert: true, conflito: "telefone" });
  await supabasePost("respostas", { telefone: telefoneLimpo, mensagem: textoMensagem, interessado });
  if (interessado) await supabasePost("interessados", { telefone: telefoneLimpo, origem });
  return { telefone: telefoneLimpo, mensagem: textoMensagem, interessado };
}

async function enviarTextoEvolution(telefoneEntrada, mensagemEntrada) {
  const number = limparTelefone(telefoneEntrada);
  const text = String(mensagemEntrada || "").trim();

  if (!number) return { sucesso: false, erro: "Telefone vazio" };
  if (!text) return { sucesso: false, erro: "Mensagem vazia" };

  const headers = {
    "Content-Type": "application/json",
    apikey: EVOLUTION_API_KEY
  };

  const rota = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;

  const tentativas = [
    {
      nome: "oficial_textMessage",
      url: rota,
      body: { number, textMessage: { text }, delay: 1200, linkPreview: false }
    },
    {
      nome: "simples_text",
      url: rota,
      body: { number, text, delay: 1200, linkPreview: false }
    },
    {
      nome: "oficial_sem_delay",
      url: rota,
      body: { number, textMessage: { text } }
    },
    {
      nome: "numero_com_jid",
      url: rota,
      body: { number: `${number}@s.whatsapp.net`, textMessage: { text }, delay: 1200, linkPreview: false }
    }
  ];

  const resultados = [];
  for (const tentativa of tentativas) {
    const retorno = await fetchComTimeout(tentativa.url, {
      method: "POST",
      headers,
      body: JSON.stringify(tentativa.body)
    }, 35000);

    resultados.push({ nome: tentativa.nome, status: retorno.status, ok: retorno.ok, retorno: retorno.data });

    if (retorno.ok) {
      return {
        sucesso: true,
        metodo: tentativa.nome,
        telefone: number,
        mensagem: text,
        retorno: retorno.data,
        diagnostico: resultados
      };
    }
  }

  return {
    sucesso: false,
    telefone: number,
    mensagem: text,
    erro: "Nenhum formato de envio foi aceito pela Evolution API",
    diagnostico: resultados
  };
}

app.get("/", (req, res) => res.redirect("/painel"));

app.get("/status", (req, res) => {
  res.json({
    online: true,
    sistema: "Reino Zap",
    versao: "8.0.0",
    modo: "envio-whatsapp-com-diagnostico",
    evolution: { url: EVOLUTION_URL, instance: EVOLUTION_INSTANCE }
  });
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
    const nome = req.body.nome || "";
    const status = req.body.status || "novo";
    if (!telefone) return res.status(400).json({ sucesso: false, erro: "Telefone obrigatório" });
    await supabasePost("contatos", { telefone, nome, status }, { upsert: true, conflito: "telefone" });
    res.json({ sucesso: true, mensagem: "Contato salvo", telefone, nome, status });
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

app.get("/interessados", async (req, res) => {
  try {
    const interessados = await supabaseGet("interessados");
    res.json({ sucesso: true, total: interessados.length, interessados });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/evolution/testar-envio", async (req, res) => {
  const telefone = req.query.telefone || "";
  const mensagem = req.query.mensagem || "Teste Reino Zap ✅";
  const resultado = await enviarTextoEvolution(telefone, mensagem);
  res.json(resultado);
});

app.post("/evolution/enviar", async (req, res) => {
  const resultado = await enviarTextoEvolution(req.body.telefone, req.body.mensagem);
  res.json(resultado);
});

app.post("/campanhas/enviar", async (req, res) => {
  try {
    const campanhaId = req.body.campanhaId;
    const limite = Number(req.body.limite || 5);
    const intervalo = Number(req.body.intervalo || 8000);
    const campanhas = await supabaseGet("campanhas");
    const campanha = campanhas.find((c) => String(c.id) === String(campanhaId));
    if (!campanha) return res.status(404).json({ sucesso: false, erro: "Campanha não encontrada" });

    const contatos = await supabaseGet("contatos");
    const selecionados = contatos.slice(0, limite);
    const resultados = [];

    for (const contato of selecionados) {
      const resultado = await enviarTextoEvolution(contato.telefone, campanha.mensagem);
      resultados.push({ telefone: contato.telefone, ...resultado });
      await aguardar(intervalo);
    }

    res.json({ sucesso: true, campanhaId, total: resultados.length, resultados });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

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
    console.log("WEBHOOK RECEBIDO:", JSON.stringify(req.body));
    const telefone = req.body?.data?.key?.remoteJid || req.body?.key?.remoteJid || req.body?.number || req.body?.telefone || "sem-telefone";
    const mensagem = req.body?.data?.message?.conversation || req.body?.data?.message?.extendedTextMessage?.text || req.body?.message?.conversation || req.body?.message?.extendedTextMessage?.text || req.body?.text || req.body?.mensagem || "";
    const resultado = await salvarMensagem({ telefone, mensagem, origem: "whatsapp" });
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    console.log("Erro webhook:", erro.message);
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
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#07152d;color:#fff}header{padding:28px 16px;text-align:center;background:#09224b;border-bottom:4px solid #2563eb}h1{font-size:36px;margin:0 0 10px}header p{font-size:20px;margin:0;color:#e5e7eb}main{padding:16px;max-width:900px;margin:auto}.card{background:#0b1730;border:1px solid #334155;border-radius:18px;padding:18px;margin-bottom:18px}h2{color:#93c5fd;margin-top:0}input,textarea,select,button{width:100%;padding:15px;border-radius:14px;border:1px solid #334155;background:#071226;color:#fff;font-size:17px;margin-bottom:12px}textarea{min-height:120px}button{border:0;font-weight:bold;cursor:pointer}.azul{background:#2563eb}.verde{background:#16a34a}.laranja{background:#f97316}.vermelho{background:#dc2626}.msg{white-space:pre-wrap;word-break:break-word;background:#020617;border-radius:12px;padding:12px;color:#fde68a}.item{padding:12px;border:1px solid #334155;border-radius:12px;margin:8px 0;background:#020617}.small{font-size:13px;color:#94a3b8}</style>
</head>
<body>
<header><h1>👑 Reino Zap</h1><p>Painel de envio de ofertas pelo WhatsApp</p></header>
<main>
<div class="card"><h2>1. Adicionar contato</h2><input id="nome" placeholder="Nome opcional"><input id="telefone" placeholder="Telefone: 558899999999"><button class="azul" onclick="salvarContato()">Salvar contato</button><div id="msgContato" class="msg"></div></div>
<div class="card"><h2>2. Criar campanha</h2><textarea id="campanha" placeholder="Mensagem da campanha"></textarea><button class="verde" onclick="criarCampanha()">Salvar campanha</button><div id="msgCampanha" class="msg"></div></div>
<div class="card"><h2>3. Envio teste</h2><input id="testeTelefone" placeholder="Telefone com 55"><textarea id="testeMensagem">Teste Reino Zap ✅</textarea><button class="laranja" onclick="enviarTeste()">Enviar teste no WhatsApp</button><div id="msgTeste" class="msg"></div></div>
<div class="card"><h2>4. Enviar campanha</h2><select id="selectCampanha"></select><input id="limite" type="number" value="5" placeholder="Quantidade máxima"><input id="intervalo" type="number" value="8000" placeholder="Intervalo em ms"><button class="vermelho" onclick="enviarCampanha()">Enviar campanha para contatos</button><p class="small">Use poucos contatos no início.</p><div id="msgEnvio" class="msg"></div></div>
<div class="card"><h2>Contatos</h2><button class="azul" onclick="carregarDados()">Atualizar</button><div id="listaContatos"></div></div>
<div class="card"><h2>Campanhas</h2><div id="listaCampanhas"></div></div>
</main>
<script>
async function api(url, options){const r=await fetch(url,options);return await r.json()}
function setMsg(id,obj){document.getElementById(id).textContent=typeof obj==='string'?obj:JSON.stringify(obj,null,2)}
async function salvarContato(){setMsg('msgContato','Salvando...');const r=await api('/contatos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:document.getElementById('nome').value,telefone:document.getElementById('telefone').value})});setMsg('msgContato',r);carregarDados()}
async function criarCampanha(){setMsg('msgCampanha','Salvando...');const r=await api('/campanhas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mensagem:document.getElementById('campanha').value})});setMsg('msgCampanha',r);carregarDados()}
async function enviarTeste(){setMsg('msgTeste','Enviando e aguardando retorno da Evolution...');const r=await api('/evolution/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:document.getElementById('testeTelefone').value,mensagem:document.getElementById('testeMensagem').value})});setMsg('msgTeste',r)}
async function enviarCampanha(){setMsg('msgEnvio','Enviando campanha...');const r=await api('/campanhas/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({campanhaId:document.getElementById('selectCampanha').value,limite:document.getElementById('limite').value,intervalo:document.getElementById('intervalo').value})});setMsg('msgEnvio',r)}
async function carregarDados(){const contatos=await api('/contatos');const campanhas=await api('/campanhas');document.getElementById('listaContatos').innerHTML=(contatos.contatos||[]).map(c=>'<div class="item"><b>'+(c.nome||'Sem nome')+'</b><br>'+c.telefone+'</div>').join('')||'Nenhum contato';document.getElementById('listaCampanhas').innerHTML=(campanhas.campanhas||[]).map(c=>'<div class="item"><b>ID '+c.id+'</b><br>'+c.mensagem+'</div>').join('')||'Nenhuma campanha';document.getElementById('selectCampanha').innerHTML=(campanhas.campanhas||[]).map(c=>'<option value="'+c.id+'">ID '+c.id+' - '+String(c.mensagem).slice(0,40)+'</option>').join('')||'<option>Nenhuma campanha</option>'}
carregarDados();
</script>
</body></html>`);
});

app.listen(PORT, () => console.log(`Reino Zap V8 rodando na porta ${PORT}`));
