require('dotenv').config();
const OpenAI = require('openai');
const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname)));
app.use(cors({ origin: '*' }));

const parser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sentiment-bot/1.0)' },
  timeout: 10000
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sentimentCache = new Map();

// OpenAI usage cap
let openaiCallCount = 0;
const MAX_OPENAI_CALLS = 900;

// Optional: reset cap every hour
setInterval(() => {
  openaiCallCount = 0;
  console.log("🔄 OpenAI call counter reset.");
}, 60 * 60 * 1000);

// Your sentiment keyword lists here
const positiveWords = [
  'happy', 'joy', 'excited', 'love', 'inspired', 'grateful',
  'amazing', 'proud', 'confident', 'hopeful', 'hope', 'peace', 'freedom',
  'great', 'cheerful', 'uplifted', 'accomplished', 'peaceful', 'motivated', 'encouraged',
  'better', 'progress', 'good life', 'success', 'wins', 'celebrates', 'growth', 'breakthrough',
  'improves', 'achieves', 'strong', 'record-high', 'optimistic', 'thriving', 'surges',
  'praises', 'boosts', 'innovative',  'peacetalk', 'relief', 
  'renewed', 'miracle', 'win','pioneer','pioneering','inventor', 
  'ceasefire','evacuate'
];
const negativeWords = [
  'sad', 'angry', 'hate', 'depressed','deadly','dead', 'frustrated', 'hopeless', 'anxious',
  'scared', 'tired', 'lonely', 'miserable', 'worthless', 'failure', 'afraid','war','killing'
];
const contrastWords = [
  'shocking', 'unbelievable','but','despite'
];
const negativePhrases = [
  "real difficulties", "very difficult","seeking help", "seeking support", "seeking shelters","mass shooting","mass murder","mass killing"
];
const positivePhrases = ['better world', 'good vibes', 'unsung hero'
                         ];

const NEGATIVE_WEIGHT = 0.5;
const PHRASE_PENALTY_PER_MATCH = 0.75;
const CONTRAST_PENALTY_FACTOR = 0.5;
const PHRASE_BONUS_WEIGHT = 0.75;

function localSentimentScore(text) {
  let positiveCount = 0;
  let negativeCount = 0;
  let positivePhraseBonus = 0;
  const lowerText = text.toLowerCase();

  positiveWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lowerText)) positiveCount++;
  });

  negativeWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lowerText)) negativeCount++;
  });

  for (const contrast of contrastWords) {
    const contrastIndex = lowerText.indexOf(contrast);
    if (contrastIndex !== -1) {
      const before = lowerText.slice(0, contrastIndex);
      for (const word of positiveWords) {
        if (before.includes(word)) {
          positiveCount = Math.ceil(positiveCount * CONTRAST_PENALTY_FACTOR);
          break;
        }
      }
    }
  }

  let phrasePenalty = 0;
  for (const phrase of negativePhrases) {
    const regex = new RegExp(`\\b${phrase.toLowerCase()}\\b`, 'i');
    if (regex.test(lowerText)) phrasePenalty += PHRASE_PENALTY_PER_MATCH;
  }

  for (const phrase of positivePhrases) {
    const regex = new RegExp(`\\b${phrase.toLowerCase()}\\b`, 'i');
    if (regex.test(lowerText)) positivePhraseBonus += PHRASE_BONUS_WEIGHT;
  }

  const weightedPositives = positiveCount + positivePhraseBonus;
  const weightedNegatives = (negativeCount * NEGATIVE_WEIGHT) + phrasePenalty;
  const totalWeighted = weightedPositives + weightedNegatives;

  const score = totalWeighted === 0 ? 0 : (weightedPositives - weightedNegatives) / totalWeighted;
  const signalStrength = weightedPositives + weightedNegatives;
  const sentimentCertainty = Math.abs(score);
  const lengthFactor = Math.min(1, text.length / 200);
  const confidence = Math.min(1, (signalStrength / 10) * sentimentCertainty * lengthFactor);

  return { score, confidence };
}

async function getSentimentScore(text) {
  if (text.length < 20 || openaiCallCount >= MAX_OPENAI_CALLS) {
    // 🔁 Fallback: use local keyword scoring
    return localSentimentScore(text);
  }

  try {
    openaiCallCount++;
    console.log(`OpenAI scoring (call #${openaiCallCount})`);

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a bilingual assistant trained to detect bias framing in headlines and news snippets in English or French.
Analyze the emotional content and potential bias in this news text using perspective-aware decoding, that is to consider how different political or ideological perspectives are treated, what assumptions are made, and how moral or intellectual legitimacy is granted or denied to different viewpoints.
Important rule for emotional language:
Do not classify emotional or violent language (e.g., “killed”, "genocide", “airstrike”, “bombed”, “famine”, “exorbitant”) as bias if:
It is attributed to a known actor, or if It describes verifiable, factual harm, and if It follows standard journalistic usage.
In such cases, do not use “Loaded Language” as the framing type unless the wording exaggerates, speculates, or is clearly intended to provoke without factual grounding. 
Instead, focus on thematic framing (e.g., “Humanitarian Crisis”, “Conflict and Consequences”, “Human Impact”).

Your response must be a JSON object: 
{
Bias Score (0–3, where 0 = none, 3 = extreme bias)
Framing Type (from categories like: Humanitarian Crisis, Conflict and Consequences, Economic Impact, Security Threat, Policy Debate, Partisan Conflict, Human Interest, Loaded Language, etc.)
Confidence %
Reason Summary - Explain how the framing may influence readers’ perception of responsibility, morality, or urgency, considering your bias rules above.
}`
        },
        {
          role: "user",
          content: text
        }
      ]
    });

    const parsed = JSON.parse(aiResponse.choices[0].message.content);
    return {
      score: parseFloat(parsed["Bias Score"]),
      emotion: String(parsed["Framing Type"]),
      reason: String(parsed["Reason Summary"]),
      confidence: parseFloat(parsed["Confidence %"])
    };

  } catch (err) {
    console.error("❌ OpenAI scoring failed:", err.message);
    // Fallback to local if AI fails
    return localSentimentScore(text);
  }
}
/* from here 
{
    role: "system",
    content: `You are a bilingual assistant trained to detect bias framing in headlines and news snippets in English or French.
Your goal is not to judge truth or political alignment, but to identify **rhetorical or structural framing choices** that may influence how readers interpret events, actors, or responsibility.
 “Bias framing” refers to emotionally manipulative or structurally imbalanced language that:
- Justifies or obscures violence
- Minimizes civilian impact
- Uses vague or euphemistic phrasing to deflect responsibility
- Erases legal or moral context around acts of war or repression

Do **not** treat emotionally direct language (e.g., “killed”, “airstrike”, “bombed”) as biased **if**:
- It is attributed to a known actor
- It describes verifiable or factual harm
- It follows standard journalistic usage

Use the following to helpndetect bias:
1. **Identify the agent** responsible for the action or event (if named).
2. **Describe how the action is framed** — is it neutral, passive, euphemistic, justified, or explicit?
3. **Evaluate whether moral or legal context is present or missing** — including any mention of proportionality, international law, occupation, or humanitarian conditions.
4. **Assess whether civilian impact is named, minimized, or omitted.**
5. **Identify framing techniques used**, if any

Provide a score for the level of biased language, the framing type (if any), the confidence % on how confident you are, and a short reason summary of how this framing may influence readers' perception of responsibility and morality.
Your response must be a JSON object:
*/ // to here 

function isRecent(pubDate) {
  if (!pubDate) return false;
  const parsedDate = new Date(pubDate);
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);  // data back 3 days ago
  return !isNaN(parsedDate.getTime()) && parsedDate >= sevenDaysAgo && parsedDate <= now;
}

app.get('/bbc/rss', async (req, res) => {
  const sources = [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
  //  'https://feeds.skynews.com/feeds/rss/world.xml',
    'https://www.aljazeera.com/xml/rss/all.xml',
    'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    'https://www.lemonde.fr/rss/une.xml'
  ];

  try {
    let allItems = [];

    for (const url of sources) {
      try {
        console.log(`📡 Fetching: ${url}`);
        const feed = await parser.parseURL(url);

        const items = feed.items
          .filter(item => isRecent(item.pubDate))
          .slice(0, 25);

        for (const item of items) {
          const combinedText = `${item.title || ''} ${item.description || ''}`;
          const { score, reason, emotion, confidence } = await getSentimentScore(combinedText);
        // const emotion = score > 0 ? 'UpBeat' : score < 0 ? 'DownBeat' : 'Neutral';

          allItems.push({
            source: feed.title || new URL(url).hostname,
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            description: item.contentSnippet || item.content || '',
            sentimentScore: parseFloat(score.toFixed(4)),
            confidence: parseFloat(confidence.toFixed(4)),
            emotion,
            reason
          });
        }
      } catch (err) {
        console.error(`❌ Feed failed (${url}):`, err.message);
      }
    }

    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    res.json(allItems.slice(0, 50));
  } catch (err) {
    console.error("❌ RSS processing failed:", err.message);
    res.status(500).json({ error: "RSS error" });
  }
});

// Test + info routes
app.get('/test', async (req, res) => {
  const input = req.query.q || 'This is a peaceful and hopeful message.';
  const result = await getSentimentScore(input);
  res.json({ input, ...result });
});

app.get('/bbc/rss/info', (req, res) => {
  res.json({
    endpoint: "/bbc/rss",
    description: "Returns RSS news articles with sentiment analysis.",
    fields: {
      source: "News outlet name",
      title: "Headline of the article",
      link: "URL to the article",
      pubDate: "Publication date",
      description: "Article snippet",
      sentimentScore: "Between 0 (neutral, impartial) to 1 (emotionally charged)",
      confidence: "How reliable the score is",
      emotion: "The charge of emotion type ",
      reason: "Reason for the score"
    }
  });
});
app.get('/', (req, res) => {
  res.send("✅ News Sentiment API is live. Use /bbc/rss or /bbc/rss/info.");
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
 
