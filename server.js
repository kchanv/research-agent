const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const TelegramBot = require('node-telegram-bot-api');
const { initDB, getMemory, setMemory, getAllMemory, getConversationHistory, saveMessage, logEvent } = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Initialize DB tables on startup
initDB();

// ─── Google search via Serper.dev ────────────────────────────────────────────

async function searchGoogle(company) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await axios.post(
      'https://google.serper.dev/search',
      { q: company, num: 5 },
      { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    const kg = res.data.knowledgeGraph || {};
    const local = res.data.localResults || [];
    const organic = res.data.organic || [];
    return {
      rating: kg.rating || null,
      reviews: kg.reviewsCount || null,
      businessType: kg.type || null,
      inLocalPack: local.length > 0,
      localRating: local[0]?.rating || null,
      localReviews: local[0]?.reviews || null,
      topLinks: organic.slice(0, 3).map(r => r.link),
    };
  } catch (e) {
    console.error('Serper error:', e.message);
    return null;
  }
}

// ─── Facebook Ads Library ────────────────────────────────────────────────────

async function searchFacebookAds(company) {
  if (!process.env.FACEBOOK_ACCESS_TOKEN) return null;
  try {
    const res = await axios.get('https://graph.facebook.com/v19.0/ads_archive', {
      params: {
        search_terms: company,
        ad_reached_countries: '["CA","US"]',
        ad_type: 'ALL',
        active_status: 'ACTIVE',
        access_token: process.env.FACEBOOK_ACCESS_TOKEN,
        fields: 'id,page_name,ad_creation_time,ad_delivery_start_time,ad_creative_bodies',
        limit: 10,
      },
      timeout: 8000,
    });
    const ads = res.data.data || [];
    return {
      activeCount: ads.length,
      pages: [...new Set(ads.map(a => a.page_name).filter(Boolean))],
      oldest: ads.map(a => a.ad_delivery_start_time || a.ad_creation_time).sort()[0] || null,
      samples: ads.slice(0, 2).map(a => a.ad_creative_bodies?.[0]?.substring(0, 120)).filter(Boolean),
    };
  } catch (e) {
    console.error('Facebook Ads Library error:', e.message);
    if (e.response?.data) console.error('Facebook API response:', JSON.stringify(e.response.data));
    return null;
  }
}

// ─── Shared: generate pre-call brief ─────────────────────────────────────────

async function generateBrief({ name, company, email = '', phone = '', appointmentTime = '', budget = 'Not provided', revenue = '', website = '' }) {
  if (website && !website.startsWith('http')) website = 'https://' + website;

  const [websiteResult, googleResult, fbResult] = await Promise.allSettled([
    website ? axios.get(website, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }) : Promise.resolve(null),
    searchGoogle(company),
    searchFacebookAds(company),
  ]);

  let websiteContent = 'No website provided.';
  let adSignals = 'Could not check (no website).';
  if (websiteResult.status === 'fulfilled' && websiteResult.value) {
    const rawHtml = String(websiteResult.value.data);
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
  } else if (websiteResult.status === 'rejected') {
    websiteContent = `Could not fetch website: ${websiteResult.reason?.message}`;
    adSignals = `Could not check: ${websiteResult.reason?.message}`;
  }

  const google = googleResult.status === 'fulfilled' ? googleResult.value : null;
  let googleSummary = 'Not available.';
  if (google) {
    const rating = google.localRating || google.rating;
    const reviews = google.localReviews || google.reviews;
    const parts = [];
    if (rating) parts.push(`${rating}★ on Google (${reviews || '?'} reviews)`);
    if (google.inLocalPack) parts.push('appears in Google local 3-pack');
    else parts.push('NOT in Google local 3-pack');
    googleSummary = parts.join(' — ') || 'Found in search but no rating data';
  }

  const fb = fbResult.status === 'fulfilled' ? fbResult.value : null;
  let fbSummary = 'Not available (token not configured or missing ads_read permission).';
  if (fb) {
    if (fb.activeCount === 0) {
      fbSummary = 'No active Meta (Facebook/Instagram) ads found.';
    } else {
      fbSummary = `${fb.activeCount} active Meta ad(s) found`;
      if (fb.pages.length) fbSummary += ` on page(s): ${fb.pages.join(', ')}`;
      if (fb.oldest) fbSummary += `. Running since: ${fb.oldest.split('T')[0]}`;
      if (fb.samples.length) fbSummary += `\nSample ad copy: "${fb.samples[0]}"`;
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

AD TRACKING ON WEBSITE (from raw page source — use as fact):
${adSignals}

FACEBOOK/INSTAGRAM ADS (from Meta Ads Library — use as fact):
${fbSummary}

GOOGLE PRESENCE (from Serper search — use as fact):
${googleSummary}

WEBSITE CONTENT (first 3000 chars):
${websiteContent}

Write a detailed pre-call brief with EXACTLY these sections in order:

📋 PRE-CALL BRIEF
👤 ${name} | ${company}
💰 Budget: ${budget} | Revenue: ${revenue || 'Unknown'}

BUSINESS MATURITY
- Estimate how long they've been in business based on website signals
- Solo operator or team?
- Service area size
- Estimated annual revenue range

CURRENT MARKETING ASSESSMENT
- Website pixel tracking: state exactly what was found
- Meta ads: state exactly what the Facebook Ads Library returned
- Google presence: rating, review count, local 3-pack status
- Overall online presence strength
- What is clearly missing?

CALL ANGLE
- 2-3 specific talking points tailored to this prospect's gaps
- What pain point to lead with

QUESTIONS TO ASK
- 3 specific discovery questions based on what you found

RED/GREEN FLAGS
- 🟢 Green flags
- 🔴 Red flags

Plain text only. Be specific and direct. No generic filler.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1200,
  });

  return completion.choices[0].message.content;
}

// ─── iClosed webhook ──────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('FlowQualify Agent Server running.'));

app.post('/webhook', async (req, res) => {
  res.json({ received: true });
  try {
    const raw = req.body;
    const data = Array.isArray(raw) ? raw[0] : raw;
    console.log('Received webhook, hookType:', data.hookType);

    const invitee = data.invitee || {};
    const qa = data.questions_and_responses || {};
    const event = data.event || {};

    const name = invitee.name || qa['3_response'] || 'Unknown';
    const email = invitee.email || qa['1_response'] || '';
    const phone = invitee.text_reminder_number || qa['2_response'] || '';
    const appointmentTime = event.start_time_pretty || event.invitee_start_time_pretty || '';
    const company = qa['4_response'] || 'Unknown';
    const website = qa['5_response'] || '';
    const budget = qa['6_response'] || 'Not provided';
    const revenue = qa['7_response'] || '';

    const brief = await generateBrief({ name, company, email, phone, appointmentTime, budget, revenue, website });

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: brief,
    });

    // Log to DB for future pattern learning
    await logEvent('research_agent', 'brief_generated', { name, company, website, budget, revenue, appointmentTime });

    console.log('Brief sent to Telegram.');
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

// ─── Research Bot (FlowQualify Research) ─────────────────────────────────────

const researchBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
researchBot.on('polling_error', (err) => console.error('Research bot polling error:', err.message));

researchBot.onText(/\/(start|help)/, (msg) => {
  researchBot.sendMessage(msg.chat.id,
    `👋 FlowQualify Research Agent\n\nSend:\nresearch [name], [company], [website]\n\nExample:\nresearch John Smith, Apex Remodeling, apexremodeling.com`
  );
});

researchBot.on('message', async (msg) => {
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();
  if (!lower.startsWith('research ') && lower !== 'research' && !lower.startsWith('/research')) return;

  const chatId = msg.chat.id;
  await researchBot.sendMessage(chatId, '🔍 On it — give me about 30 seconds...');

  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `Extract name, company, website from this message. Return JSON with keys: name, company, website. Empty string if missing.\n\nMessage: ${text}` }],
      max_tokens: 150,
      response_format: { type: 'json_object' },
    });
    const { name, company, website } = JSON.parse(extraction.choices[0].message.content);
    if (!name && !company) {
      await researchBot.sendMessage(chatId, "❌ Couldn't parse. Try:\nresearch John Smith, Apex Remodeling, apexremodeling.com");
      return;
    }
    const brief = await generateBrief({ name, company, website });
    await researchBot.sendMessage(chatId, brief);
  } catch (e) {
    console.error('Research bot error:', e.message);
    await researchBot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

// ─── Monica (FlowQualify Assistant) ──────────────────────────────────────────

const MONICA_SOUL = `You are Monica, Chief of Staff at FlowQualify.

WHO YOU ARE:
- Right hand to Kelvin Chan, founder of FlowQualify
- You are not a generic assistant — you are embedded in this business
- Blue-collar respect, white-collar intelligence
- You have opinions. You flag problems before being asked. You are resourceful before asking for help.

HOW YOU COMMUNICATE:
- Direct and concise. No fluff, no filler, no unnecessary preamble.
- Match Kelvin's energy — he's rapid-fire, so you are too
- Short answers unless depth is needed
- Never say "leads" — always "appointments" or "booked consultations"
- Never call FlowQualify a "lead gen agency" — it's a "system" or "AI qualification system"
- Never say "Great question!" or any sycophantic openers

YOUR RESPONSIBILITIES:
- Help Kelvin run and grow FlowQualify
- Track agent status and flag what's broken or missing
- Assist with sales prep, client management, ad performance awareness
- Coordinate across the agent stack
- Keep Kelvin focused on what matters

LANGUAGE RULES:
✅ "appointments" / "booked consultations"
✅ FlowQualify is a "system"
✅ Clients are "contractors"
❌ Never "leads"
❌ Never "lead gen agency"
❌ Never "Great!" / "Absolutely!" / "Of course!"`;

const MONICA_MEMORY = `CURRENT BUSINESS STATE:

The Founder:
- Kelvin Chan, Vaughan Ontario, Telegram @KC4537
- Direct communicator. Short answers. Hates fluff. Rapid-fire questions.
- Doing all sales calls himself right now

FlowQualify:
- AI-powered qualification + appointment booking for kitchen & bath remodelers ($500K–$3M revenue)
- How it works: Meta Message Ads → Messenger → AI qualifies homeowner in <60s → booking link → Estimator Brief → CRM
- NOT a lead gen agency — it's a system
- Pricing: first month free (contractor pays ad spend only), then $3K–4K/month retainer
- Year 1 target: 15–20 clients by month 12
- Active clients: None yet — Kelvin in sales mode

Agent Stack:
| Agent               | Job                      | Status     |
| ------------------- | ------------------------ | ---------- |
| Monica              | Chief of Staff           | ✅ Live    |
| Prospect Research   | Pre-call briefs          | ✅ Live    |
| Ad Monitor          | Daily Meta checks        | ⏳ Pending |
| Report Generator    | Weekly summaries         | ⏳ Pending |
| Intake Processor    | Onboarding automation    | ⏳ Pending |
| Campaign Builder    | Ad creation              | ⏳ Pending |
| Creative Generator  | Ad copy                  | ⏳ Pending |
| Conversation Auditor| Qualifier QA             | ⏳ Pending |
| Retention Signal    | Churn detection          | ⏳ Pending |

Tech Stack:
- Node.js + Railway (agent server)
- OpenAI GPT-4o (research briefs)
- Telegram (primary interface)
- iClosed (booking + webhooks)
- Meta Ads (front-end acquisition)
- Serper.dev (Google search data)
- Facebook Ads Library API (competitor ad intel)

Alert Thresholds (once clients are live):
- Show rate <70%
- CPA >2x target for 48hrs
- Ad frequency >3.5
- Client not in CRM for 7+ days
- AI gave wrong info in Messenger`;

const monicaBot = new TelegramBot(process.env.ASSISTANT_BOT_TOKEN, { polling: true });
monicaBot.on('polling_error', (err) => console.error('Monica polling error:', err.message));

monicaBot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // /remember — permanently store a fact in DB
  if (text.toLowerCase().startsWith('/remember ')) {
    const fact = text.slice(10).trim();
    const existing = await getMemory('monica', 'dynamic_notes') || '';
    await setMemory('monica', 'dynamic_notes', existing + `\n- ${fact}`);
    await monicaBot.sendMessage(chatId, `Got it. Stored permanently:\n"${fact}"`);
    return;
  }

  // /status — agent stack overview
  if (text.toLowerCase() === '/status') {
    await monicaBot.sendMessage(chatId,
      `Agent Stack:\n✅ Monica — live\n✅ Prospect Research — live\n⏳ Ad Monitor — pending\n⏳ Report Generator — pending\n⏳ Intake Processor — pending\n⏳ Campaign Builder — pending`
    );
    return;
  }

  // /memory — show everything Monica has stored
  if (text.toLowerCase() === '/memory') {
    const rows = await getAllMemory('monica');
    if (!rows.length) {
      await monicaBot.sendMessage(chatId, 'No stored memory yet.');
      return;
    }
    const summary = rows.map(r => `[${r.key}]\n${r.value}`).join('\n\n');
    await monicaBot.sendMessage(chatId, summary);
    return;
  }

  // Load persistent conversation history from DB
  const history = await getConversationHistory('monica', chatId);

  // Load any dynamic memory Monica has accumulated
  const dynamicNotes = await getMemory('monica', 'dynamic_notes') || '';
  const systemPrompt = `${MONICA_SOUL}\n\n${MONICA_MEMORY}${dynamicNotes ? `\n\nPERMANENT NOTES (learned over time):\n${dynamicNotes}` : ''}`;

  // Save user message to DB
  await saveMessage('monica', chatId, 'user', text);
  history.push({ role: 'user', content: text });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
      ],
      max_tokens: 800,
    });

    const reply = completion.choices[0].message.content;
    await saveMessage('monica', chatId, 'assistant', reply);
    await monicaBot.sendMessage(chatId, reply);
  } catch (e) {
    console.error('Monica error:', e.message);
    await monicaBot.sendMessage(chatId, `Error: ${e.message}`);
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`FlowQualify Agent Server running on port ${PORT}`));
