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
const MAX_OPENAI_CALLS = 500;

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
const positivePhrases = ['better world', 'aid delivered to Gaza', 'good vibes', 'unsung hero',
                         'returning home'
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
    console.log(` OpenAI scoring (call #${openaiCallCount})`);

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      temperature: 0.3,
      messages: [
  {
    role: "system",
    content: `You are a bilingual media analysis assistant. Your task is to detect **bias framing** in news-related text in either English or French.

Bias framing refers to emotionally or ideologically loaded language that shapes how events or people are perceived. You are not judging truth or political alignment — only whether the **language framing** introduces bias. return stict json between 0 and 1 with 0 no bias detected at all 1 biased detected

Evaluate the input and return a JSON object with this format:

{
  "score": number,
 "framing_type": string | null,      // e.g., "emotional language", "loaded terms", "one-sided framing", etc.
 // "examples": [string],               // short phrases or quotes from the text that indicate bias framing
  "confidence": number                // 0 to 1, how confident you are in this judgment
}

---

Vous êtes un assistant bilingue d’analyse médiatique. Votre tâche est de détecter la **présence d’un cadrage biaisé** dans un texte d’actualité en anglais ou en français.

Le cadrage biaisé désigne un langage émotionnellement ou idéologiquement chargé qui influence la perception des événements ou des personnes. Vous ne jugez pas la véracité ni l’orientation politique — seulement si le **langage introduit un biais de cadrage** avec un score de 0 a 1 ou 0 est pas de biai détecte et 1 fort biais détecte

Évaluez le texte et retournez un objet JSON avec ce format :

{
  "score": number,
  "framing_type": string | null,      // ex. : "langage émotionnel", "termes connotés", "cadrage unilatéral", etc.
//  "examples": [string],               // extraits courts du texte qui montrent ce cadrage biaisé
  "confidence": number                // de 0 à 1, niveau de confiance dans cette évaluation
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
      score: parseFloat(parsed.score),
      confidence: parseFloat(parsed.confidence),
      emotion: parseFloat(parsed.framing_type),
    };
  
     const local = localSentimentScore(text);
     const ai = await getSentimentScore(text);
     console.log("Local:", local);
   console.log("AI:", ai);

  } catch (err) {
    console.error("❌ OpenAI scoring failed:", err.message);
    // Fallback to local if AI fails
    return localSentimentScore(text);
  }
}

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
    //'https://feeds.skynews.com/feeds/rss/world.xml',
    'https://www.aljazeera.com/xml/rss/all.xml',
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
          .slice(0, 15);

        for (const item of items) {
          const combinedText = `${item.title || ''} ${item.description || ''}`;
          const { score, confidence, emotion } = await getSentimentScore(combinedText);
        // const emotion = score > 0 ? 'UpBeat' : score < 0 ? 'DownBeat' : 'Neutral';

          allItems.push({
            source: feed.title || new URL(url).hostname,
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            description: item.contentSnippet || item.content || '',
            sentimentScore: parseFloat(score.toFixed(4)),
            confidence: parseFloat(confidence.toFixed(4)),
            emotion
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
      sentimentScore: "Range: -1 (negative) to 1 (positive)",
      confidence: "How reliable the score is (0–1)",
      emotion: "Categorical label: UpBeat, DownBeat, or Neutral"
    }
  });
});

app.get('/', (req, res) => {
  res.send("✅ News Sentiment API is live. Use /bbc/rss or /bbc/rss/info.");
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
 
