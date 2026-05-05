}
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// 🔥 salvar contato
async function salvarContato(telefone, mensagem) {
  await fetch(${SUPABASE_URL}/rest/v1/contatos, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: Bearer ${SUPABASE_KEY},
    },
    body: JSON.stringify({
      telefone,
      ultima_mensagem: mensagem,
    }),
  });
}

// 🔥 salvar resposta
async function salvarResposta(telefone, mensagem, interessado) {
  await fetch(${SUPABASE_URL}/rest/v1/respostas, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: Bearer ${SUPABASE_KEY},
    },
    body: JSON.stringify({
      telefone,
      mensagem,
      interessado,
    }),
  });
}

// 🔥 detectar interesse
function detectarInteresse(msg) {
  const texto = msg.toLowerCase();

  const palavras = [
    "quero",
    "valor",
    "participar",
    "pix",
    "manda",
    "interesse",
    "comprar",
  ];

  return palavras.some((p) => texto.includes(p));
}

// 🔥 rota teste
app.get("/", (req, res) => {
  res.send("Backend Reino Zap ONLINE 🚀");
});

// 🔥 simular recebimento de mensagem
app.post("/webhook", async (req, res) => {
  try {
    const { telefone, mensagem } = req.body;

    const interessado = detectarInteresse(mensagem);

    await salvarContato(telefone, mensagem);
    await salvarResposta(telefone, mensagem, interessado);

    if (interessado) {
      await fetch(${SUPABASE_URL}/rest/v1/interessados, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: Bearer ${SUPABASE_KEY},
        },
        body: JSON.stringify({
          telefone,
          origem: "whatsapp",
        }),
      });
    }

    res.json({ sucesso: true, interessado });
  } catch (err) {
    console.log(err);
    res.status(500).json({ erro: "erro interno" });
  }
});

app.listen(PORT, () => {
  console.log("Servidor rodando 🚀");
})
