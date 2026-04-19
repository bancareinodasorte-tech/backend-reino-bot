import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

const EVOLUTION_URL = 'https://evolution-api-production-db99.up.railway.app';
const EVOLUTION_INSTANCE = 'reino';
const EVOLUTION_API_KEY = '303778';

app.get('/', (req, res) => {
  res.send('Backend Reino da Sorte online ✅');
});

app.get('/teste', (req, res) => {
  res.json({ ok: true, mensagem: 'rota teste funcionando' });
});

function extrairNumero(body) {
  return (
    body?.data?.key?.remoteJid ||
    body?.data?.messages?.[0]?.key?.remoteJid ||
    body?.key?.remoteJid ||
    ''
  );
}

function extrairMensagem(body) {
  return (
    body?.data?.message?.conversation ||
    body?.data?.message?.extendedTextMessage?.text ||
    body?.data?.message?.imageMessage?.caption ||
    body?.data?.message?.videoMessage?.caption ||
    body?.data?.messages?.[0]?.message?.conversation ||
    body?.data?.messages?.[0]?.message?.extendedTextMessage?.text ||
    body?.message?.conversation ||
    body?.message?.extendedTextMessage?.text ||
    ''
  );
}

function mensagemEnviadaPorMim(body) {
  return Boolean(
    body?.data?.key?.fromMe ||
    body?.data?.messages?.[0]?.key?.fromMe ||
    body?.key?.fromMe
  );
}

function deveIgnorarNumero(numero) {
  return (
    !numero ||
    numero.endsWith('@g.us') ||
    numero === 'status@broadcast' ||
    numero.includes('broadcast')
  );
}

async function enviarMensagem(numero, texto) {
  const numeroLimpo = String(numero)
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .replace(/\D/g, '');

  const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;

  const payload = {
    number: numeroLimpo,
    text: texto
  };

  console.log('Enviando para Evolution:', payload);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const data = await response.text();
  console.log('Status Evolution:', response.status);
  console.log('Resposta Evolution:', data);
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    console.log('===== WEBHOOK RECEBIDO =====');
    console.log(JSON.stringify(body, null, 2));

    const numero = extrairNumero(body);
    const textoOriginal = extrairMensagem(body);
    const texto = String(textoOriginal).trim();

    console.log('Número extraído:', numero);
    console.log('Texto extraído:', texto);

    if (mensagemEnviadaPorMim(body)) {
      console.log('Ignorado: mensagem enviada por mim');
      return res.sendStatus(200);
    }

    if (deveIgnorarNumero(numero)) {
      console.log('Ignorado: grupo/status/broadcast');
      return res.sendStatus(200);
    }

    if (!texto) {
      console.log('Ignorado: sem texto');
      return res.sendStatus(200);
    }

    await enviarMensagem(
      numero,
      `✅ TESTE DO BOT OK

Recebi sua mensagem:
"${texto}"

Se você recebeu isso, webhook + Evolution + backend estão funcionando.`
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error('ERRO NO WEBHOOK:', error);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});