import express from 'express';
import cors from 'cors';
import fs from 'fs';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const EVOLUTION_URL = process.env.EVOLUTION_URL || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN || '';
const PAGBANK_ENV = process.env.PAGBANK_ENV || 'production';
const PAGBANK_API_URL = PAGBANK_ENV === 'sandbox'
  ? 'https://sandbox.api.pagseguro.com'
  : 'https://api.pagseguro.com';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://backend-reino-bot.onrender.com';
const PRECO_BILHETE = Number(process.env.PRECO_BILHETE || 2);
const PIX_EXPIRA_MINUTOS = Number(process.env.PIX_EXPIRA_MINUTOS || 30);

const CLIENTE_PADRAO_NOME = process.env.CLIENTE_PADRAO_NOME || 'Cliente Reino da Sorte';
const CLIENTE_PADRAO_EMAIL = process.env.CLIENTE_PADRAO_EMAIL || 'cliente@reinodasorte.com.br';
const CLIENTE_PADRAO_CPF = process.env.CLIENTE_PADRAO_CPF || '12345678909';
const CLIENTE_PADRAO_DDD = process.env.CLIENTE_PADRAO_DDD || '88';
const CLIENTE_PADRAO_TELEFONE = process.env.CLIENTE_PADRAO_TELEFONE || '999999999';

const PEDIDOS_PATH = './data/pedidos.json';
const EVENTOS_PATH = './data/eventos-pagbank.json';

function garantirPastaData() {
  if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
}

function readJson(path, fallback) {
  try {
    garantirPastaData();
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  garantirPastaData();
  fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function agoraBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
}

function somenteNumeros(texto) {
  return String(texto || '').replace(/\D/g, '');
}

function limparNumeroWhatsApp(numero) {
  return somenteNumeros(String(numero || '').replace('@s.whatsapp.net', '').replace('@c.us', ''));
}

function valorBR(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function valorCentavos(valorReais) {
  return Math.round(Number(valorReais || 0) * 100);
}

function expiraEmISO(minutos) {
  return new Date(Date.now() + minutos * 60 * 1000).toISOString();
}

function gerarReferencia(numero, quantidade) {
  const curto = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RDS-${Date.now()}-${quantidade}-${numero.slice(-4)}-${curto}`;
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

function salvarEventoPagBank(evento) {
  const eventos = readJson(EVENTOS_PATH, []);
  eventos.unshift({ recebidoEm: agoraBR(), evento });
  writeJson(EVENTOS_PATH, eventos.slice(0, 200));
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

async function enviarTexto(numero, texto) {
  console.log('ENVIANDO PARA:', numero);
  console.log(texto);

  if (!EVOLUTION_URL || !EVOLUTION_INSTANCE || !EVOLUTION_API_KEY) {
    console.log('EVOLUTION NÃO CONFIGURADA');
    return;
  }

  const url = `${EVOLUTION_URL.replace(/\/$/, '')}/message/sendText/${EVOLUTION_INSTANCE}`;

  const resposta = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_API_KEY
    },
    body: JSON.stringify({
      number: numero,
      text: texto
    })
  });

  const retorno = await resposta.text();

  if (!resposta.ok) {
    console.log('ERRO AO ENVIAR WHATSAPP:', resposta.status, retorno);
  } else {
    console.log('WHATSAPP ENVIADO COM SUCESSO');
  }
}

async function criarPixPagBank({ numero, quantidade }) {
  if (!PAGBANK_TOKEN) throw new Error('PAGBANK_TOKEN não configurado');

  const valor = quantidade * PRECO_BILHETE;
  const referencia = gerarReferencia(numero, quantidade);

  const body = {
    reference_id: referencia,
    customer: {
      name: CLIENTE_PADRAO_NOME,
      email: CLIENTE_PADRAO_EMAIL,
      tax_id: somenteNumeros(CLIENTE_PADRAO_CPF),
      phones: [{
        country: '55',
        area: somenteNumeros(CLIENTE_PADRAO_DDD),
        number: somenteNumeros(CLIENTE_PADRAO_TELEFONE),
        type: 'MOBILE'
      }]
    },
    items: [{
      reference_id: `bilhetes-${quantidade}`,
      name: 'Bilhetes Reino da Sorte',
      quantity: 1,
      unit_amount: valorCentavos(valor)
    }],
    qr_codes: [{
      amount: { value: valorCentavos(valor) },
      expiration_date: expiraEmISO(PIX_EXPIRA_MINUTOS)
    }],
    notification_urls: [`${PUBLIC_BASE_URL.replace(/\/$/, '')}/webhook-pagbank`]
  };

  const resposta = await fetch(`${PAGBANK_API_URL}/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PAGBANK_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-idempotency-key': referencia.replace(/[^a-zA-Z0-9]/g, '')
    },
    body: JSON.stringify(body)
  });

  const texto = await resposta.text();
  let json = {};
  try { json = JSON.parse(texto); } catch { json = { raw: texto }; }

  if (!resposta.ok) {
    console.log('ERRO PAGBANK:', resposta.status, json);
    throw new Error(`PagBank recusou o Pix: ${resposta.status}`);
  }

  const qr = json?.qr_codes?.[0] || {};
  return {
    referencia,
    orderId: json?.id,
    quantidade,
    valor,
    pixCopiaCola: qr?.text || '',
    respostaPagBank: json
  };
}

function mensagemInicial() {
  return `🟢 CENTRAL AUTOMÁTICA DE VENDAS
REINO DA SORTE

⚡ Este canal é exclusivo para compras.

Digite apenas a quantidade de bilhetes desejada.

Exemplo:
5

Cada bilhete custa ${valorBR(PRECO_BILHETE)}.`;
}

function mensagemForaDoFluxo() {
  return `⚠️ Não entendi sua mensagem.

Para comprar, digite apenas a quantidade de bilhetes.

Exemplo:
5`;
}

function mensagemPixGerado(pedido) {
  return `🧾 PEDIDO GERADO

Quantidade: ${pedido.quantidade} bilhete${pedido.quantidade > 1 ? 's' : ''}
Valor total: ${valorBR(pedido.valor)}

💳 PAGAMENTO VIA PIX COPIA E COLA

Copie o código abaixo e pague no app do seu banco:

${pedido.pixCopiaCola}

Após pagar, envie o comprovante aqui.

🔒 Compra segura e oficial
⚡ Liberação rápida após confirmação
📄 Comprovante dos bilhetes em PDF`;
}

function mensagemErroPix() {
  return `⚠️ Não foi possível gerar o Pix automático agora.

Digite novamente a quantidade de bilhetes em alguns instantes.`;
}

function mensagemPedirDados() {
  return `🔎 COMPROVANTE RECEBIDO

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

async function processarMensagem(numero, texto, recebeuMidia) {
  console.log('PROCESSANDO:', { numero, texto, recebeuMidia });

  if (!pedidoAtual(numero)) {
    salvarPedido(numero, { etapa: 'aguardando_quantidade' });
  }

  const textoLimpo = String(texto || '').trim();

  if (/^(menu|comprar|iniciar|oi|olá|ola)$/i.test(textoLimpo)) {
    salvarPedido(numero, { etapa: 'aguardando_quantidade' });
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
    salvarPedido(numero, {
      etapa: 'aguardando_geracao_pdf',
      dadosCliente: textoLimpo
    });
    await enviarTexto(numero, mensagemProcessando());
    return;
  }

  const quantidade = Number(somenteNumeros(textoLimpo));

  if (!quantidade || quantidade <= 0 || quantidade > 500) {
    salvarPedido(numero, { etapa: 'aguardando_quantidade' });
    await enviarTexto(numero, mensagemForaDoFluxo());
    return;
  }

  try {
    await enviarTexto(numero, `⏳ Gerando Pix de ${valorBR(quantidade * PRECO_BILHETE)}...`);

    const pix = await criarPixPagBank({ numero, quantidade });

    salvarPedido(numero, {
      etapa: 'aguardando_pagamento',
      quantidade,
      valor: pix.valor,
      referencia: pix.referencia,
      orderId: pix.orderId,
      pixCopiaCola: pix.pixCopiaCola,
      statusPagamento: 'AGUARDANDO'
    });

    await enviarTexto(numero, mensagemPixGerado(pix));
  } catch (error) {
    console.log('ERRO AO GERAR PIX:', error.message);
    salvarPedido(numero, { etapa: 'aguardando_quantidade' });
    await enviarTexto(numero, mensagemErroPix());
  }
}

async function receberWebhook(req, res) {
  try {
    console.log('================ WEBHOOK CHEGOU ================');
    console.log(JSON.stringify(req.body, null, 2));

    const payload = req.body;

    if (mensagemFoiMinha(payload)) {
      return res.json({ ok: true, ignorado: 'mensagem enviada por mim' });
    }

    const numero = extrairNumero(payload);
    const texto = extrairTexto(payload);
    const recebeuMidia = temMidia(payload);

    console.log('DADOS EXTRAÍDOS:', { numero, texto, recebeuMidia });

    if (!numero) {
      return res.json({ ok: true, ignorado: 'sem número' });
    }

    await processarMensagem(numero, texto, recebeuMidia);

    res.json({ ok: true });
  } catch (error) {
    console.log('ERRO NO WEBHOOK:', error);
    res.status(500).json({ ok: false, erro: error.message });
  }
}

app.get('/', (req, res) => {
  res.send('Bot Vendas Reino da Sorte + PagBank Pix online ✅');
});

app.get('/teste', (req, res) => {
  res.json({
    ok: true,
    mensagem: 'Bot funcionando ✅',
    pagbank: PAGBANK_TOKEN ? 'token configurado' : 'token não configurado',
    evolution: EVOLUTION_URL && EVOLUTION_INSTANCE && EVOLUTION_API_KEY ? 'evolution configurada' : 'evolution incompleta',
    ambiente: PAGBANK_ENV,
    horario: agoraBR()
  });
});

app.get('/webhook', (req, res) => {
  res.send('Webhook existe ✅ Use POST para receber mensagens.');
});

app.post('/webhook', receberWebhook);
app.post('/webhook/:evento', receberWebhook);

app.post('/webhook-pagbank', async (req, res) => {
  try {
    salvarEventoPagBank(req.body);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get('/pedidos', (req, res) => res.json(readJson(PEDIDOS_PATH, {})));
app.get('/eventos-pagbank', (req, res) => res.json(readJson(EVENTOS_PATH, [])));

app.get('/simular', async (req, res) => {
  const numero = limparNumeroWhatsApp(req.query.numero || '5588994943632');
  const texto = String(req.query.texto || '1');
  const midia = String(req.query.midia || '') === '1';

  await processarMensagem(numero, texto, midia);

  res.json({
    ok: true,
    mensagem: 'Simulação enviada',
    numero,
    texto,
    midia
  });
});

app.post('/simular', async (req, res) => {
  const numero = limparNumeroWhatsApp(req.body.numero || '5588994943632');
  const texto = String(req.body.texto || '1');
  const midia = Boolean(req.body.midia);

  await processarMensagem(numero, texto, midia);

  res.json({ ok: true, numero, texto, midia });
});

app.listen(PORT, () => {
  console.log(`Bot Vendas Reino da Sorte rodando na porta ${PORT}`);
});