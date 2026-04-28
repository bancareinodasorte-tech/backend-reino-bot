import express from 'express';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

const EVOLUTION_URL = process.env.EVOLUTION_URL || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';

const PRECO_BILHETE = Number(process.env.PRECO_BILHETE || 2);
const WHATSAPP_ESCRITORIO = process.env.WHATSAPP_ESCRITORIO || '5588994943632';

const PAGAMENTOS_PATH = './data/pagamentos.json';
const PEDIDOS_PATH = './data/pedidos.json';

function readJson(path, fallback) {
  try {
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    console.log(`Erro ao ler ${path}:`, error.message);
    return fallback;
  }
}

function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function somenteNumeros(texto) {
  return String(texto || '').replace(/\D/g, '');
}

function limparNumeroWhatsApp(numero) {
  return somenteNumeros(String(numero || '').replace('@s.whatsapp.net', '').replace('@c.us', ''));
}

function extrairNumero(payload) {
  return limparNumeroWhatsApp(
    payload?.data?.key?.remoteJid ||
    payload?.data?.remoteJid ||
    payload?.data?.sender ||
    payload?.sender ||
    payload?.from ||
    payload?.remoteJid ||
    ''
  );
}

function mensagemFoiMinha(payload) {
  return Boolean(payload?.data?.key?.fromMe || payload?.data?.fromMe);
}

function extrairTexto(payload) {
  const msg = payload?.data?.message || payload?.message || {};
  return String(
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.documentMessage?.caption ||
    payload?.data?.messageText ||
    payload?.data?.text ||
    payload?.body ||
    payload?.text ||
    ''
  ).trim();
}

function temMidia(payload) {
  const msg = payload?.data?.message || payload?.message || {};
  return Boolean(msg?.imageMessage || msg?.documentMessage || msg?.videoMessage);
}

function valorBR(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function agoraBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
}

function salvarPedido(numero, dados) {
  const pedidos = readJson(PEDIDOS_PATH, {});
  pedidos[numero] = { ...(pedidos[numero] || {}), ...dados, atualizadoEm: agoraBR() };
  writeJson(PEDIDOS_PATH, pedidos);
  return pedidos[numero];
}

function pedidoAtual(numero) {
  const pedidos = readJson(PEDIDOS_PATH, {});
  return pedidos[numero] || null;
}

function listarQuantidadesDisponiveis() {
  const pagamentos = readJson(PAGAMENTOS_PATH, {});
  return Object.keys(pagamentos).map(Number).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
}

function linkPagamentoPorQuantidade(qtd) {
  const pagamentos = readJson(PAGAMENTOS_PATH, {});
  return pagamentos[String(qtd)] || '';
}

async function enviarTexto(numero, texto) {
  if (!EVOLUTION_URL || !EVOLUTION_INSTANCE || !EVOLUTION_API_KEY) {
    console.log('RESPOSTA SIMULADA PARA', numero, '\n', texto);
    return;
  }

  const url = `${EVOLUTION_URL.replace(/\/$/, '')}/message/sendText/${EVOLUTION_INSTANCE}`;

  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
    body: JSON.stringify({ number: numero, text: texto })
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    console.log('Erro ao enviar mensagem:', resposta.status, erro);
  }
}

function mensagemInicial() {
  return `🟢 CENTRAL AUTOMÁTICA DE VENDAS
REINO DA SORTE

⚡ Este canal é exclusivo para compras.

Digite apenas a quantidade de bilhetes desejada.

Exemplo:
5

Cada bilhete custa R$ ${PRECO_BILHETE.toFixed(2).replace('.', ',')}`;
}

function mensagemPagamento(qtd, link) {
  const valor = qtd * PRECO_BILHETE;
  return `🧾 PEDIDO GERADO

Quantidade: ${qtd} bilhete${qtd > 1 ? 's' : ''}
Valor total: ${valorBR(valor)}

💳 PAGAMENTO VIA PIX:
${link}

Após pagar, envie o comprovante aqui.

🔒 Compra segura e oficial
⚡ Liberação rápida após confirmação
📄 Comprovante dos bilhetes em PDF`;
}

function mensagemSemLink(qtd) {
  const disponiveis = listarQuantidadesDisponiveis();
  const lista = disponiveis.length ? disponiveis.join(', ') : 'nenhuma quantidade cadastrada ainda';
  return `⚠️ Ainda não existe link de pagamento cadastrado para ${qtd} bilhete${qtd > 1 ? 's' : ''}.

Quantidades disponíveis no automático:
${lista}

Digite uma das quantidades acima.`;
}

function mensagemPedirDados() {
  return `🔎 PAGAMENTO RECEBIDO

Agora envie os dados para gerar seus bilhetes:

Nome:
Telefone:

Exemplo:
Nome: Maria Silva
Telefone: 88999999999`;
}

function mensagemProcessando() {
  return `✅ DADOS RECEBIDOS

Sua compra está sendo processada.

Aguarde a geração dos bilhetes em PDF.`;
}

function mensagemForaDoFluxo() {
  return `Digite somente a quantidade de bilhetes desejada.

Exemplo:
5`;
}

async function processarMensagem(numero, texto, recebeuMidia) {
  if (!pedidoAtual(numero)) salvarPedido(numero, { etapa: 'aguardando_quantidade' });

  const textoLimpo = String(texto || '').trim();

  if (/^menu$/i.test(textoLimpo) || /^comprar$/i.test(textoLimpo) || /^iniciar$/i.test(textoLimpo)) {
    await enviarTexto(numero, mensagemInicial());
    return;
  }

  if (recebeuMidia || /comprovante|paguei|pago|pix feito|transferido/i.test(textoLimpo)) {
    salvarPedido(numero, { etapa: 'aguardando_dados', comprovanteRecebido: true });
    await enviarTexto(numero, mensagemPedirDados());
    return;
  }

  const etapa = pedidoAtual(numero)?.etapa || 'aguardando_quantidade';

  if (etapa === 'aguardando_dados') {
    salvarPedido(numero, { etapa: 'aguardando_geracao_pdf', dadosCliente: textoLimpo });
    await enviarTexto(numero, mensagemProcessando());
    return;
  }

  const qtd = Number(somenteNumeros(textoLimpo));

  if (!qtd || qtd <= 0 || qtd > 999) {
    await enviarTexto(numero, mensagemForaDoFluxo());
    return;
  }

  const link = linkPagamentoPorQuantidade(qtd);

  if (!link || link.includes('COLE_AQUI')) {
    await enviarTexto(numero, mensagemSemLink(qtd));
    return;
  }

  salvarPedido(numero, { etapa: 'aguardando_pagamento', quantidade: qtd, valor: qtd * PRECO_BILHETE, linkPagamento: link });
  await enviarTexto(numero, mensagemPagamento(qtd, link));
}

app.get('/', (req, res) => res.send('Bot de Vendas Reino da Sorte online ✅'));

app.get('/teste', (req, res) => res.json({ ok: true, mensagem: 'Bot funcionando ✅', horario: agoraBR() }));

app.get('/pagamentos', (req, res) => res.json(readJson(PAGAMENTOS_PATH, {})));

app.get('/pedidos', (req, res) => res.json(readJson(PEDIDOS_PATH, {})));

app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const evento = String(payload?.event || payload?.type || '').toLowerCase();

    if (evento && !evento.includes('message') && !evento.includes('messages')) {
      return res.json({ ok: true, ignorado: 'evento não é mensagem' });
    }

    if (mensagemFoiMinha(payload)) {
      return res.json({ ok: true, ignorado: 'mensagem enviada por mim' });
    }

    const numero = extrairNumero(payload);
    const texto = extrairTexto(payload);
    const recebeuMidia = temMidia(payload);

    if (!numero) return res.json({ ok: true, ignorado: 'sem número' });

    await processarMensagem(numero, texto, recebeuMidia);
    res.json({ ok: true });
  } catch (error) {
    console.log('Erro no webhook:', error);
    res.status(500).json({ ok: false, erro: error.message });
  }
});

app.post('/simular', async (req, res) => {
  const numero = limparNumeroWhatsApp(req.body.numero || WHATSAPP_ESCRITORIO);
  const texto = String(req.body.texto || '');
  const midia = Boolean(req.body.midia);
  await processarMensagem(numero, texto, midia);
  res.json({ ok: true, numero, texto, midia });
});

app.listen(PORT, () => console.log(`Bot de Vendas Reino da Sorte rodando na porta ${PORT}`));
