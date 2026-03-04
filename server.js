const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

app.get('/', (req, res) => res.send('Research Agent is running.'));

app.post('/webhook', async (req, res) => {
  // Respond immediately so iClosed doesn't retry
  res.json({ received: true });

  try {
    const data = req.body;
    console.log('Received webhook:', JSON.stringify(data, null, 2));

    // Extract core fields
    const name = data.name || data.contact_name || data.full_name || 'Unknown';
    const email = data.email || '';
    const phone = data.phone || data.phone_number || '';
    const appointmentTime = data.start_time_pretty || data.appointment_time || data.start_time || '';

    // Extract from questions_and_responses
    const qa = data.questions_and_responses || data.questions_and_answers || {};

    // Try common structures for company, budget, website
    const company =
      data.company ||
      data.business_name ||
      qa['1_response'] || qa['1_answer'] ||
      (Array.isArray(qa) && qa[0]?.answer) ||
      'Unknown';

    const budget =
      qa['3_response'] || qa['3_answer'] ||
      (Array.isArray(qa) && qa[2]?.answer) ||
      data.budget ||
      'Not provided';

    let website =
      qa['5_response'] || qa['5_answer'] ||
      (Array.isArray(qa) && qa[4]?.answer) ||
      data.website ||
      '';

    // Prepend https:// if missing
    if (website && !website.startsWith('http')) {
      website = 'https://' + website;
    }

    // Fetch website content
    let websiteContent = 'No website provided.';
    if (website) {
      try {
        const response = await axios.get(website, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        websiteContent = String(response.data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 3000);
      } catch (e) {
        websiteContent = `Could not fetch website: ${e.message}`;
      }
    }

    // Build OpenAI prompt
    const prompt = `You are a pre-call research assistant for a digital marketing agency that sells paid advertising and lead generation services to home service contractors (remodelers, roofers, etc.).

PROSPECT INFO:
Name: ${name}
Company: ${company}
Email: ${email}
Phone: ${phone}
Appointment: ${appointmentTime}
Budget: ${budget}
Website: ${website || 'None provided'}

WEBSITE CONTENT (first 3000 chars):
${websiteContent}

Write a detailed pre-call brief with EXACTLY these sections in order:

📋 PRE-CALL BRIEF
👤 ${name} | ${company}
💰 Budget: ${budget}

BUSINESS MATURITY
- Estimate how long they've been in business based on website signals (domain age clues, copyright year, "X years experience" mentions, etc.)
- Solo operator or team? (look for "our team", staff photos, multiple roles mentioned)
- Service area size (local city, regional, statewide?)
- Estimated annual revenue range based on company size signals (solo = $200k-$500k, small team = $500k-$2M, established = $2M+)

CURRENT MARKETING ASSESSMENT
- Do they appear to be running ads? (look for Facebook pixel, Google tag, ad-related scripts in the page)
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

    const brief = completion.choices[0].message.content;
    console.log('Generated brief:', brief);

    // Send to Telegram
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: brief,
    });

    console.log('Brief sent to Telegram successfully.');
  } catch (error) {
    console.error('Error processing webhook:', error.message);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Research Agent running on port ${PORT}`));
