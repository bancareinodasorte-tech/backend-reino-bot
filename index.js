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

async function supabaseRequest(tabela, dados, options = {}) {
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

async function salvarMensagem({ telefone, mensagem, origem }) {
  const telefoneLimpo = limparTelefone(telefone);
  const textoMensagem = String(mensagem || "");
  const interessado = detectarInteresse(textoMensagem);

  await supabaseRequest(
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

  await supabaseRequest("respostas", {
    telefone: telefoneLimpo,
    mensagem: textoMensagem,
    interessado
  });

  if (interessado) {
    await supabaseRequest("interessados", {
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
  res.send("Backend Reino Zap ONLINE 🚀 Supabase conectado ✅");
});

app.get("/webhook", (req, res) => {
  res.send("Webhook existe ✅ Use POST para receber mensagens.");
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
    console.error("Erro no teste:", erro.message);

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
  console.log(`Servidor rodando na porta ${PORT} 🚀`);
});
