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
    return null;
  }
}

// ─── Shared: generate pre-call brief ────────────────────────────────────────

async function generateBrief({ name, company, email = '', phone = '', appointmentTime = '', budget = 'Not provided', revenue = '', website = '' }) {
  if (website && !website.startsWith('http')) website = 'https://' + website;

  // Run all data fetches in parallel
  const [websiteResult, googleResult, fbResult] = await Promise.allSettled([
    // Website scrape
    website ? axios.get(website, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }) : Promise.resolve(null),
    searchGoogle(company),
    searchFacebookAds(company),
  ]);

  // Website content + pixel detection
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

  // Google data summary
  const google = googleResult.status === 'fulfilled' ? googleResult.value : null;
  let googleSummary = 'Not available (Serper not configured).';
  if (google) {
    const rating = google.localRating || google.rating;
    const reviews = google.localReviews || google.reviews;
    const parts = [];
    if (rating) parts.push(`${rating}★ on Google (${reviews || '?'} reviews)`);
    if (google.inLocalPack) parts.push('appears in Google local 3-pack');
    else parts.push('NOT in Google local 3-pack');
    googleSummary = parts.length > 0 ? parts.join(' — ') : 'Found in search but no rating data';
  }

  // Facebook Ads summary
  const fb = fbResult.status === 'fulfilled' ? fbResult.value : null;
  let fbSummary = 'Not available (Facebook token not configured or missing ads_read permission).';
  if (fb) {
    if (fb.activeCount === 0) {
      fbSummary = 'No active Meta (Facebook/Instagram) ads found for this company name.';
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
- Estimate how long they've been in business based on website signals (domain age clues, copyright year, "X years experience" mentions, etc.)
- Solo operator or team? (look for "our team", staff photos, multiple roles mentioned)
- Service area size (local city, regional, statewide?)
- Estimated annual revenue range based on company size signals (solo = $200k-$500k, small team = $500k-$2M, established = $2M+)

CURRENT MARKETING ASSESSMENT
- Website pixel tracking: state exactly what was found
- Meta ads: state exactly what the Facebook Ads Library returned — active ads, since when, sample copy if available
- Google presence: state their rating, review count, and whether they're in the local 3-pack
- Overall online presence strength
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
    max_tokens: 1200,
  });

  return completion.choices[0].message.content;
}

// ─── iClosed webhook ─────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('Research Agent is running.'));

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
