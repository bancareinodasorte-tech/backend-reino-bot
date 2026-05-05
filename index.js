import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

app.get("/", (req, res) => {
  res.send("Backend Reino Zap V1 ONLINE 🚀");
});

app.get("/status", (req, res) => {
  res.json({
    online: true,
    sistema: "Reino Zap",
    versao: "1.0.0"
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

    if (!telefone) {
      return res.status(400).json({
        sucesso: false,
        erro: "Telefone obrigatório"
      });
    }

    await supabasePost(
      "contatos",
      {
        telefone,
        nome,
        status
      },
      {
        upsert: true,
        conflito: "telefone"
      }
    );

    res.json({
      sucesso: true,
      mensagem: "Contato salvo",
      telefone,
      nome,
      status
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/interessados", async (req, res) => {
  try {
    const interessados = await supabaseGet("interessados");
    res.json({
      sucesso: true,
      total: interessados.length,
      interessados
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/campanhas", async (req, res) => {
  try {
    const campanhas = await supabaseGet("campanhas");
    res.json({
      sucesso: true,
      total: campanhas.length,
      campanhas
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.post("/campanhas", async (req, res) => {
  try {
    const mensagem = String(req.body.mensagem || "").trim();

    if (!mensagem) {
      return res.status(400).json({
        sucesso: false,
        erro: "Mensagem da campanha é obrigatória"
      });
    }

    await supabasePost("campanhas", {
      mensagem,
      status: "pendente",
      enviados: 0
    });

    res.json({
      sucesso: true,
      mensagem: "Campanha criada"
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

app.get("/webhook", (req, res) => {
  res.send("Webhook ativo ✅ Use POST para receber mensagens do WhatsApp.");
});

app.get("/teste", async (req, res) => {
  try {
    const resultado = await salvarMensagem({
      telefone: req.query.telefone || "558899999999",
      mensagem: req.query.mensagem || "quero participar",
      origem: "teste"
    });

    res.json({
      sucesso: true,
      ...resultado
    });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      erro: erro.message
    });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const telefone =
      req.body.telefone ||
      req.body.number ||
      req.body.remoteJid ||
      req.body?.data?.key?.remoteJid ||
      req.body?.key?.remoteJid ||
      "sem-telefone";

    const mensagem =
      req.body.mensagem ||
      req.body.text ||
      req.body.message ||
      req.body?.data?.message?.conversation ||
      req.body?.data?.message?.extendedTextMessage?.text ||
      req.body?.message?.conversation ||
      req.body?.message?.extendedTextMessage?.text ||
      "";

    const resultado = await salvarMensagem({
      telefone,
      mensagem,
      origem: "whatsapp"
    });

    res.json({
      sucesso: true,
      ...resultado
    });
  } catch (erro) {
    console.error("Erro no webhook:", erro.message);

    res.status(500).json({
      sucesso: false,
      erro: erro.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Reino Zap rodando na porta ${PORT} 🚀`);
});
