const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Shared: generate pre-call brief ────────────────────────────────────────

async function generateBrief({ name, company, email = '', phone = '', appointmentTime = '', budget = 'Not provided', revenue = '', website = '' }) {
  if (website && !website.startsWith('http')) website = 'https://' + website;

  let websiteContent = 'No website provided.';
  let adSignals = 'Could not check (no website).';
  if (website) {
    try {
      const response = await axios.get(website, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const rawHtml = String(response.data);

      // Detect tracking pixels / ad scripts from raw HTML before stripping tags
      const detected = [];
      if (/fbq\(|connect\.facebook\.net|facebook\.com\/tr/i.test(rawHtml)) detected.push('Facebook Pixel');
      if (/googletagmanager\.com\/gtm/i.test(rawHtml)) detected.push('Google Tag Manager');
      if (/gtag\(|google-analytics\.com|ga\('send'/i.test(rawHtml)) detected.push('Google Analytics / Google Ads');
      if (/ttq\.|tiktok\.com\/i18n\/pixel/i.test(rawHtml)) detected.push('TikTok Pixel');
      if (/snaptr\(|sc-static\.net/i.test(rawHtml)) detected.push('Snapchat Pixel');
      if (/pintrk\(|ct\.pinterest\.com/i.test(rawHtml)) detected.push('Pinterest Ads');
      adSignals = detected.length > 0
        ? `CONFIRMED tracking scripts found: ${detected.join(', ')}`
        : 'No ad tracking pixels detected in page source (likely not running paid ads)';

      websiteContent = rawHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 3000);
    } catch (e) {
      websiteContent = `Could not fetch website: ${e.message}`;
      adSignals = `Could not check: ${e.message}`;
    }
  }

  const prompt = `You are a pre-call research assistant for a digital marketing agency that sells paid advertising and lead generation services to home service contractors (remodelers, roofers, etc.).

PROSPECT INFO:
Name: ${name}
Company: ${company}
Email: ${email}
Phone: ${phone}
Appointment: ${appointmentTime}
Budget: ${budget}
Annual Revenue: ${revenue || 'Not provided'}
Website: ${website || 'None provided'}

AD TRACKING DETECTED (from raw page source — use this as fact, do not guess):
${adSignals}

WEBSITE CONTENT (first 3000 chars):
${websiteContent}

Write a detailed pre-call brief with EXACTLY these sections in order:

📋 PRE-CALL BRIEF
👤 ${name} | ${company}
💰 Budget: ${budget} | Revenue: ${revenue || 'Unknown'}

BUSINESS MATURITY
- Estimate how long they've been in business based on website signals (domain age clues, copyright year, "X years experience" mentions, etc.)
- Solo operator or team? (look for "our team", staff photos, multiple roles mentioned)
- Service area size (local city, regional, statewide?)
- Estimated annual revenue range based on company size signals (solo = $200k-$500k, small team = $500k-$2M, established = $2M+)

CURRENT MARKETING ASSESSMENT
- Ad activity: use the AD TRACKING DETECTED field above — state exactly what was found or confirmed not found. Do not say "further inspection needed".
- Reviews/reputation signals (mention if Houzz, Angi, BBB, Google reviews are referenced)
- How strong is their online presence? (professional site vs basic vs none)
- What is clearly missing from their marketing?

CALL ANGLE
- 2-3 specific talking points tailored to THIS prospect based on their gaps
- What pain point to lead with based on their situation

QUESTIONS TO ASK
- 3 specific discovery questions tailored to their business based on what you found

RED/GREEN FLAGS
- 🟢 Green flags (signals they're a good fit / ready to invest)
- 🔴 Red flags (signals to watch out for)

Plain text only. Be specific and direct. No generic filler.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000,
  });

  return completion.choices[0].message.content;
}

// ─── iClosed webhook ─────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('Research Agent is running.'));

app.post('/webhook', async (req, res) => {
  // Respond immediately so iClosed doesn't retry
  res.json({ received: true });

  try {
    const data = req.body;
    console.log('=== WEBHOOK RECEIVED ===');
    console.log('Body type:', typeof data);
    console.log('Top-level keys:', Object.keys(data || {}));
    console.log('Has invitee:', !!data.invitee);
    console.log('Has questions_and_responses:', !!data.questions_and_responses);
    console.log('Full body:', JSON.stringify(data, null, 2));

    // iClosed nests contact info under invitee, but questions_and_responses may be top-level
    const invitee = data.invitee || data;
    const qa = data.questions_and_responses
      || data.questions_and_answers
      || invitee.questions_and_responses
      || invitee.questions_and_answers
      || {};

    // iClosed question order: 1=email, 2=phone, 3=full name, 4=business, 5=website, 6=budget, 7=revenue
    const name = invitee.name || qa['3_response'] || qa['Full Name'] || data.name || 'Unknown';
    const email = invitee.email || qa['1_response'] || qa['Email Address'] || '';
    const phone = invitee.text_reminder_number || qa['2_response'] || qa['Phone Number'] || '';
    const appointmentTime = data.start_time_pretty || data.appointment_time || data.start_time || invitee.created_at || '';
    const company = qa['4_response'] || qa['What is the name of your business?'] || data.company || 'Unknown';
    const website = qa['5_response'] || qa["What is your company's website?"] || data.website || '';
    const budget = qa['6_response'] || qa['What is your total monthly marketing budget?'] || data.budget || 'Not provided';
    const revenue = qa['7_response'] || qa['What is your annual revenue?'] || '';

    const brief = await generateBrief({ name, company, email, phone, appointmentTime, budget, revenue, website });
    console.log('Generated brief:', brief);

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: brief,
    });

    console.log('Brief sent to Telegram successfully.');
  } catch (error) {
    console.error('Error processing webhook:', error.message);
  }
});

// ─── Telegram bot (interactive commands) ─────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

bot.onText(/\/(start|help)/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 FlowQualify Research Agent\n\nTo research a prospect manually, send:\n\nresearch [name], [company], [website]\n\nExamples:\nresearch John Smith, Apex Remodeling, apexremodeling.com\nresearch John Smith, Apex Remodeling`
  );
});

bot.on('message', async (msg) => {
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();

  if (!lower.startsWith('research ') && lower !== 'research' && !lower.startsWith('/research')) return;

  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '🔍 On it — give me about 30 seconds...');

  try {
    // Use GPT to extract structured info from the natural language message
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Extract the prospect's name, company name, and website URL from this message. Return valid JSON only with keys: name, company, website. If a field is missing use an empty string.\n\nMessage: ${text}`,
      }],
      max_tokens: 150,
      response_format: { type: 'json_object' },
    });

    const { name, company, website } = JSON.parse(extraction.choices[0].message.content);

    if (!name && !company) {
      await bot.sendMessage(chatId, "❌ Couldn't parse a name or company. Try:\nresearch John Smith, Apex Remodeling, apexremodeling.com");
      return;
    }

    const brief = await generateBrief({ name, company, website });
    await bot.sendMessage(chatId, brief);
  } catch (e) {
    console.error('Bot research error:', e.message);
    await bot.sendMessage(chatId, `❌ Something went wrong: ${e.message}`);
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Research Agent running on port ${PORT}`));
