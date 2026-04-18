import express from 'express';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

app.get('/', (req, res) => {
  res.send('Backend Reino da Sorte online ✅');
});

app.get('/ranking', (req, res) => {
  const vendedores = readJson('./data/vendedores.json');
  const vendas = readJson('./data/vendas.json');

  const totais = {};

  vendas.forEach((venda) => {
    if (venda.status === 'PAGO') {
      totais[venda.vendedorId] = (totais[venda.vendedorId] || 0) + Number(venda.valor || 0);
    }
  });

  const ranking = vendedores.map((vendedor) => ({
    id: vendedor.id,
    nome: vendedor.nome,
    total: totais[vendedor.id] || 0
  }));

  ranking.sort((a, b) => b.total - a.total);

  res.json(ranking);
});

app.post('/webhook', (req, res) => {
  console.log('Webhook recebido:', req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
