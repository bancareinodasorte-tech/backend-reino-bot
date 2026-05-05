// Reino Zap V13
console.log('V13 ativo');
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Reino Zap V13 rodando 🚀');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT);
});
