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
    const prompt = `You are a pre-call research assistant for a digital marketing agency. Generate a concise pre-call brief.

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

Write a brief with exactly these 3 sections:
1. PRE-CALL BRIEF — Start with a header line: "📋 PRE-CALL BRIEF" then "👤 ${name} | ${company}" then "💰 Budget: ${budget}"
2. WEBSITE SUMMARY — 2-3 sentences about their business based on the website
3. CALL ANGLE — 2-3 specific, actionable talking points tailored to this prospect

Plain text only. No bullet symbols except dashes. Keep it tight and useful.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
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
