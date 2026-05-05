import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const EVOLUTION_URL = "https://evolution-api-production-db99.up.railway.app";
const EVOLUTION_INSTANCE = "reino4";
const EVOLUTION_API_KEY = "2FFDDECB0586-4E9A-8C8C-EFC332EC4F24";

function detectarInteresse(mensagem = "") {
  const texto = mensagem.toLowerCase();
  const palavras = ["quero","comprar","participar","pix","valor","manda","bilhete","bilhetes","tenho interesse","vou querer"];
  return palavras.some((p) => texto.includes(p));
}

async function supabaseUpsert(tabela, dados) {
  const resposta = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify(dados)
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Erro Supabase ${tabela}: ${erro}`);
  }
}

app.get("/status", (req, res) => {
  res.json({ status: "online", versao: "5.0.0" });
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK:", JSON.stringify(req.body));

    const telefone = req.body?.data?.key?.remoteJid || "sem-telefone";
    const mensagem =
      req.body?.data?.message?.conversation ||
      req.body?.data?.message?.extendedTextMessage?.text ||
      "";

    const interessado = detectarInteresse(mensagem);

    await supabaseUpsert("contatos", {
      telefone,
      ultima_mensagem: mensagem,
      interessado
    });

    await supabaseUpsert("respostas", {
      telefone,
      mensagem,
      interessado
    });

    if (interessado) {
      await supabaseUpsert("interessados", {
        telefone,
        origem: "whatsapp"
      });
    }

    res.sendStatus(200);
  } catch (erro) {
    console.log("Erro webhook:", erro.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log("Servidor rodando 🚀");
});
