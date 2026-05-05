import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function detectarInteresse(mensagem = "") {
  const texto = mensagem.toLowerCase();

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
    "vou querer"
  ];

  return palavras.some((p) => texto.includes(p));
}

async function supabaseInsert(tabela, dados) {
  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/public.${tabela}`, {
    method: "POST",
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
    throw new Error(`Erro Supabase ${tabela}: ${erro}`);
  }
}

app.get("/", (req, res) => {
  res.send("Backend Reino Zap ONLINE 🚀 Supabase conectado ✅");
});

app.get("/webhook", (req, res) => {
  res.send("Webhook existe ✅ Use POST para receber mensagens.");
});

app.get("/teste", async (req, res) => {
  try {
    const telefone = req.query.telefone || "558899999999";
    const mensagem = req.query.mensagem || "quero participar";

    const interessado = detectarInteresse(mensagem);

    await supabaseInsert("contatos", {
      telefone,
      ultima_mensagem: mensagem,
      interessado
    });

    await supabaseInsert("respostas", {
      telefone,
      mensagem,
      interessado
    });

    if (interessado) {
      await supabaseInsert("interessados", {
        telefone,
        origem: "teste"
      });
    }

    res.json({
      sucesso: true,
      telefone,
      mensagem,
      interessado
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
      "sem-telefone";

    const mensagem =
      req.body.mensagem ||
      req.body.text ||
      req.body.message ||
      req.body?.data?.message?.conversation ||
      req.body?.data?.message?.extendedTextMessage?.text ||
      "";

    const interessado = detectarInteresse(mensagem);

    await supabaseInsert("contatos", {
      telefone,
      ultima_mensagem: mensagem,
      interessado
    });

    await supabaseInsert("respostas", {
      telefone,
      mensagem,
      interessado
    });

    if (interessado) {
      await supabaseInsert("interessados", {
        telefone,
        origem: "whatsapp"
      });
    }

    res.json({
      sucesso: true,
      telefone,
      mensagem,
      interessado
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
