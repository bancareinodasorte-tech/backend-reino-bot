import express from 'express';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const EVOLUTION_URL = 'https://evolution-api-production-db99.up.railway.app';
const EVOLUTION_INSTANCE = 'reino';
const EVOLUTION_API_KEY = '303778';

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

function menuPrincipal() {
  return `🍀 *REINO DA SORTE* 🍀

Escolha uma opção:

1️⃣ Quero ser vendedor autorizado
2️⃣ Comprar bilhetes
3️⃣ Ver resultados
4️⃣ Falar com vendedor
5️⃣ Regulamento
6️⃣ Suporte

0️⃣ Voltar ao menu
9️⃣ Encerrar atendimento

Digite o número da opção 👇`;
}

function rodapeNavegacao() {
  return `

0️⃣ Voltar ao menu
9️⃣ Encerrar atendimento`;
}

function respostaVendedorAutorizado() {
  return `🚀 *SEJA UM VENDEDOR REINO DA SORTE*

Escolha uma modalidade:

1️⃣ Online
2️⃣ Maquininha
3️⃣ Banca
4️⃣ Comissão de vendas

Digite a opção 👇${rodapeNavegacao()}`;
}

function respostaOnline() {
  return `📱 *VENDEDOR ONLINE*

Como funciona:

• Vai até o escritório
• Faz seu cadastro presencial
• Recebe instruções rápidas
• Instala o AppVendas no celular
• Autoriza suas vendas
• Recebe sua camisa oficial

✅ Pronto! Agora você já pode vender online.${rodapeNavegacao()}`;
}

function respostaMaquininha() {
  return `💳 *VENDEDOR COM MAQUININHA*

Como funciona:

• Vai até o escritório
• Faz o cadastro presencial
• Recebe instruções
• Recebe a maquininha
• Recebe sua camisa

✅ Pronto! Já pode vender com a maquininha.${rodapeNavegacao()}`;
}

function respostaBanca() {
  return `🏪 *VENDEDOR COM BANCA*

Como funciona:

• Vai até o escritório
• Faz o cadastro
• Escolhe o local da banca
• Recebe maquininha
• Recebe estrutura e camisa

✅ Pronto! Sua banca será instalada e você começa a vender.${rodapeNavegacao()}`;
}

function respostaComissao() {
  return `💰 *COMISSÃO DE VENDAS*

Você ganha *30%* sobre tudo que vender.
Sorteio todos os dias, 6 dias na semana.

Conta simples de quanto fatura:
Dia / Semana / Mês

Cada bilhete custa R$ 2,00
Se vender 100 bilhetes:

Exemplo 1: Ganho por Dia
100 x 2 = R$ 200
30% de R$ 200 = R$ 60

Exemplo 2: Ganho por Semana
Ganhou R$ 60 no dia
R$ 60 x 6 dias = R$ 360 

Exemplo 3: Ganho por mês
Ganhou R$ 360 na semana
R$ 360 x 4 semanas = R$ 1.440,00 você faturou em um mês

100 bilhetes por dia = R$ 1.440,00 mês
200 bilhetes por dia = R$ 2.880,00 mês
300 bilhetes por dia = R$ 4.320,00 mês

*Observação*: Você pode vender quantos bilhetes quiser. *nós não temos meta, você que faz a sua*.
caso você pegue uma quantidade de bilhetes e não chegar a vender todos até o horário limite do sorteio,
os bilhetes restantes são devolvidos automaticamente ao sistema após você prestar conta. então não se limite
ao solicitar bilhetes, você não pagará pelo os que sobrou no fim das vendas, são devolvidos automaticamentes ao encerrar 
o horário limite para vendas.

Quanto mais vender, mais ganha 🚀

Para mais detalhes veja o regulamento na opção 5.${rodapeNavegacao()}`;
}

function respostaComprarBilhetes() {
  return `🎟️ *COMPRAR BILHETES*

Escolha:

1️⃣ Escolher vendedor
2️⃣ Comprar aqui no WhatsApp

Digite a opção 👇${rodapeNavegacao()}`;
}

function respostaEscolherVendedor() {
  return `👤 *ESCOLHA SEU VENDEDOR*

Acesse o painel:
👉 https://bitlybr.net/comprarbilhete/${rodapeNavegacao()}`;
}

function respostaComprarAqui() {
  return `🧾 *COMPRA DIRETA*

Envie os dados abaixo:

Quantidade de bilhetes:
Nome:
Telefone:

💳 Pagamento via PIX:
CHAVE PIX: https://bitlybr.net/pagarbilhetes

Após o pagamento, envie o comprovante.

⏳ Aguarde a confirmação.
Seu bilhete será gerado e enviado aqui.${rodapeNavegacao()}`;
}

function respostaResultados() {
  return `📊 *RESULTADOS*

Acompanhe:

📸 Instagram:
https://www.instagram.com/reinodasorteoficial?igsh=MWw4endwd3Joczc4dg==

📲 Grupo de resultados:
https://bitlybr.net/grupoclientes${rodapeNavegacao()}`;
}

function respostaFalarComVendedor() {
  return `👤 *FALAR COM VENDEDOR*

Acesse o painel:
👉 https://bitlybr.net/comprarbilhete/${rodapeNavegacao()}`;
}

function respostaRegulamento() {
  return `📜 *REGULAMENTO REINO DA SORTE*

🔹 Comissão:
30% sobre suas vendas

🔹 Pagamentos:
Você recebe dos seus clientes diretamente no seu PIX
No encerramento das vendas presta conta para o escritório
- Se recebeu em pix, transfere em pix
- Se recebeu em dinheiro, pode presta conta em dinheiro, se você tem em pix
poderá fazer em pix se caso haja impossibilidade de ir ao escritório

🔹 Prestação de contas:
Deve ser feita até 30 minutos antes do sorteio

⚠️ Caso não preste conta:
• Bilhetes não participam
• Deve devolver o dinheiro aos clientes
• Pode perder credibilidade

⚠️ Se houver prêmio:
Sem prestação de contas → prêmio inválido e novo sorteio será feito

🔹 Equipamentos:
Maquininha, banca e fardamento são sua responsabilidade

• Danificou → deve pagar
• Parou de vender sem aviso, resolveu não trabalhar mais conosco → devolução obrigatória imediata

🔹 Imagem:
Ao se cadastrar, você automaticamente autoriza uso da sua imagem para divulgação em propagandas e redes sociais
como divulgações de vendas, entragas de prêmios e outras eventualidades no tocante as vendas

🔹 Compromisso:
• Ser responsável com vendas e clientes
• Zelar no uso dos equipamentos na sua responsabilidade
• Respeitar horários de funionamento e prestação de contas
• Respeitar os colegas vendedores e colaboradores

📌 Dúvidas? Fale no suporte.${rodapeNavegacao()}`;
}

function respostaSuporte() {
  return `🛠️ *SUPORTE*

Fale com nossa equipe:
👉 https://wa.me/message/2QMML4KHRO5BL1

Ou vá até o escritório.${rodapeNavegacao()}`;
}

function respostaEncerrar() {
  return `✅ Atendimento encerrado.

Quando quiser voltar, envie:
*oi*`;
}

async function enviarMensagem(numero, texto) {
  const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;

  const payload = {
    number: numero.replace('@s.whatsapp.net', ''),
    text: texto
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const data = await response.text();
  console.log('Resposta Evolution:', data);
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    const numero = body?.data?.key?.remoteJid || body?.key?.remoteJid;
    const textoOriginal =
      body?.data?.message?.conversation ||
      body?.data?.message?.extendedTextMessage?.text ||
      body?.message?.conversation ||
      body?.message?.extendedTextMessage?.text ||
      '';

    const texto = String(textoOriginal).trim().toLowerCase();

    if (!numero || !texto) {
      return res.sendStatus(200);
    }

    console.log('Número:', numero);
    console.log('Texto:', texto);

    if (texto === 'oi' || texto === 'olá' || texto === 'ola' || texto === 'menu' || texto === '0') {
      await enviarMensagem(numero, menuPrincipal());
      return res.sendStatus(200);
    }

    if (texto === '9') {
      await enviarMensagem(numero, respostaEncerrar());
      return res.sendStatus(200);
    }

    if (texto === '1') {
      await enviarMensagem(numero, respostaVendedorAutorizado());
      return res.sendStatus(200);
    }

    if (texto === '2') {
      await enviarMensagem(numero, respostaComprarBilhetes());
      return res.sendStatus(200);
    }

    if (texto === '3') {
      await enviarMensagem(numero, respostaResultados());
      return res.sendStatus(200);
    }

    if (texto === '4') {
      await enviarMensagem(numero, respostaFalarComVendedor());
      return res.sendStatus(200);
    }

    if (texto === '5') {
      await enviarMensagem(numero, respostaRegulamento());
      return res.sendStatus(200);
    }

    if (texto === '6') {
      await enviarMensagem(numero, respostaSuporte());
      return res.sendStatus(200);
    }

    if (texto === '1.1' || texto === 'online' || texto === '11') {
      await enviarMensagem(numero, respostaOnline());
      return res.sendStatus(200);
    }

    if (texto === '1.2' || texto === 'maquininha' || texto === '12') {
      await enviarMensagem(numero, respostaMaquininha());
      return res.sendStatus(200);
    }

    if (texto === '1.3' || texto === 'banca' || texto === '13') {
      await enviarMensagem(numero, respostaBanca());
      return res.sendStatus(200);
    }

    if (texto === '1.4' || texto === 'comissão' || texto === 'comissao' || texto === '14') {
      await enviarMensagem(numero, respostaComissao());
      return res.sendStatus(200);
    }

    if (texto === '2.1' || texto === '21') {
      await enviarMensagem(numero, respostaEscolherVendedor());
      return res.sendStatus(200);
    }

    if (texto === '2.2' || texto === '22') {
      await enviarMensagem(numero, respostaComprarAqui());
      return res.sendStatus(200);
    }

    await enviarMensagem(numero, `Não entendi sua mensagem.

Digite *0* para voltar ao menu
ou *9* para encerrar atendimento.`);
    return res.sendStatus(200);
  } catch (error) {
    console.error('Erro no webhook:', error);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
