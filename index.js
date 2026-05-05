import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// rota principal
app.get("/", (req, res) => {
  res.send("Backend Reino Zap ONLINE 🚀");
});

// rota webhook (teste)
app.post("/webhook", (req, res) => {
  console.log("Mensagem recebida:", req.body);

  res.json({
    sucesso: true,
    mensagem: "Recebido com sucesso"
  });
});

app.listen(PORT, () => {
  console.log("Servidor rodando 🚀");
});
