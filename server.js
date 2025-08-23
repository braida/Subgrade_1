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
const MAX_OPENAI_CALLS = 1000;

// Optional: reset cap every hour
setInterval(() => {
  openaiCallCount = 0;
  console.log("🔄 OpenAI call counter reset.");
}, 60 * 60 * 1000);

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


// updated 
async function getSentimentScore(text) {
  if (text.length < 20 || openaiCallCount >= MAX_OPENAI_CALLS) {
    return localSentimentScore(text);
  }

  try {
    openaiCallCount++;
    console.log(`OpenAI scoring (call #${openaiCallCount})`);

    const aiResponse = await openai.chat.completions.create({
      
      model: "gpt-4o-mini",
      temperature: 0,
      // ⬇️ Force JSON
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a bilingual assistant (English & French) that detects bias framing in news text.
Each request is independent, do not reference earlier content.
Principles:
Assess how events or actors are framed, not factual accuracy or stance.
Focus on legitimacy given/denied through language, especially around human suffering, dignity, and moral impact.
Coverage of death, famine, or collapse is a humanitarian lens, not bias.
If politics and suffering both appear, human impact takes priority.
Rules:
- Strong factual terms (“killed,” “bombed,” “famine,” etc.) are not bias unless manipulative.
- Flag bias only if there is distortion, misleading omission, or one-sided framing.
- A consistent emphasis (humanitarian, security, economic, etc.) = a lens, not bias.
Provide a very short disclaimer with framing_type to surface the most relevant perspectives it omits - whether technical, ethical, human, cultural, or political.”  don't explain further the reason here.  
Provide a short summary of the text.

Return ONLY valid JSON in this schema: 
 { 
 "bias_score": number, // 0 = no bias, 3 = strong bias 
 "framing_type": string, // e.g. "Humanitarian Crisis", "Conflict and Consequences", "Political Scandal" AND  **a very short disclaimer in your framing_type selected to to surface the most relevant perspectives it omits — whether technical, ethical, human, cultural, or political.” indicate Which parts of your analysis are the most shaped by convention? and Which are based on encoded patterns? don't explain further the reason here. please be very concise **
 "confidence_pct": number, // 0-100 
 "reason_summary": string, // Always explain the framing_type and score using this equation format: Signals (textual cues in the text). Heuristics (what Heuristics used for interpretation). Encoded patterns (that impacts your decision and specify the pattern reproduced by writing a full sentences that explain how the pattern is reproduced for this analysis). = framing_type: X vs. Y. Keep short like a worked-out problem
 "aisummary": string, // Short summary of the text.
}
 `
        },
        { role: "user", content: text }
      ]
    });

    const content = aiResponse.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
      score: Number(parsed.bias_score),
      emotion: String(parsed.framing_type),
      reason: String(parsed.reason_summary),
      confidence: Number(parsed.confidence_pct),
      aisummary:String(parsed.aisummary)
    };

  } catch (err) {
    console.error("❌ OpenAI scoring failed:", err.message);
    return localSentimentScore(text);
  }
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch {}
  // try to pull the first {...} block
  const m = s.match(/{[\s\S]*}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error("Model did not return valid JSON");
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

// Assumes:
// const express = require('express');
// const app = express();
// const RSSParser = require('rss-parser');
// const parser = new RSSParser();
// async function getSentimentScore(text) { /* your function as-is */ }

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }; //1 day

// recent check
function isRecent(dateLike, days = 1) {
  if (!dateLike) return false;
  const t = Date.parse(dateLike);
  if (Number.isNaN(t)) return false;

  const now = Date.now();
  const lower = now - days * MS.day;
  const upper = now + 5 * MS.minute; // clock ahead timestamps
  return t >= lower && t <= upper;
}

// HTML stripper for descriptions
function stripHtml(s = "") {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// memory cache 
let cache = { data: null, expiresAt: 0 };

app.get('/bbc/rss', async (req, res) => {
  // Query params: ?days=1&perSource=3&limit=15
  const days = Math.max(0, parseInt(req.query.days ?? "1", 10) || 1);
  const perSource = Math.max(1, parseInt(req.query.perSource ?? "3", 10) || 3);
  const limit = Math.max(1, parseInt(req.query.limit ?? "15", 10) || 15);

  // cache
  if (cache.data && cache.expiresAt > Date.now()) {
    return res.json(cache.data.slice(0, limit));
  }

  const sources = [
    'https://feeds.bbci.co.uk/news/world/rss.xml', 
    // 'https://feeds.skynews.com/feeds/rss/world.xml',
    'https://news.un.org/feed/subscribe/en/news/all/rss.xml', 
    // 'https://ir.thomsonreuters.com/rss/sec-filings.xml?items=15', 
    'https://www.aljazeera.com/xml/rss/all.xml', 
    // 'https://www.icc-cpi.int/rss/news/all', 
    // 'https://www.rsfjournal.org/rss/current.xml',
    'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    'https://www.lemonde.fr/rss/une.xml'
  ];

  try {
    // Fetch all feeds in parallel 
    const feedResults = await Promise.allSettled(
      sources.map(async (url) => {
        console.log(`📡 Fetching: ${url}`);
        const feed = await parser.parseURL(url);
        //
        const items = (feed.items || [])
          .filter(it => isRecent(it.isoDate || it.pubDate, days))
          .slice(0, perSource)
          .map(it => ({
            source: feed.title || new URL(url).hostname,
            title: it.title || "",
            link: it.link,
            pubDate: it.isoDate || it.pubDate || null,
            // strip HTML
            description: stripHtml(it.contentSnippet || it.content || ""),
            // Sentiment fields filled later
            _combinedText: `${it.title || ''} ${stripHtml(it.contentSnippet || it.content || '')}`.trim(),
          }));

        return items;
      })
    );

    let allItems = [];
    for (const r of feedResults) {
      if (r.status === 'fulfilled') {
        allItems.push(...r.value);
      } else {
        console.error(`❌ Feed failed:`, r.reason?.message || r.reason);
      }
    }

    // deduplicate by link
    const dedupMap = new Map();
    for (const it of allItems) {
      const key = it.link || `${it.title}|${it.pubDate}`;
      if (!dedupMap.has(key)) dedupMap.set(key, it);
    }
    allItems = Array.from(dedupMap.values());

    // Get sentiment 
    const chunkSize = 10;
    const chunks = [];
    for (let i = 0; i < allItems.length; i += chunkSize) {
      chunks.push(allItems.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      const scored = await Promise.allSettled(
        chunk.map(async (item) => {
          const { score, reason, emotion, confidence, aisummary } =
            await getSentimentScore(item._combinedText);

          return {
            ...item,
            sentimentScore: Number.isFinite(score) ? Number(score.toFixed(4)) : null,
            confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(4)) : null,
            emotion: emotion ?? null,
            reason: reason ?? null,
            aisummary: aisummary ?? null,
          };
        })
      );
      for (let i = 0; i < scored.length; i++) {
        if (scored[i].status === 'fulfilled') {
          const idx = allItems.indexOf(chunk[i]);
          allItems[idx] = scored[i].value;
        } else {
          console.error('❌ Sentiment failed:', scored[i].reason?.message || scored[i].reason);
          // Keep unscored item without sentiment fields
          const idx = allItems.indexOf(chunk[i]);
          allItems[idx] = {
            ...chunk[i],
            sentimentScore: null,
            confidence: null,
            emotion: null,
            reason: null,
            aisummary: null,
          };
        }
      }
    }

    // Sort newest first
    allItems.sort((a, b) => {
      const ta = Date.parse(a.pubDate || '') || 0;
      const tb = Date.parse(b.pubDate || '') || 0;
      return tb - ta;
    });

    const payload = allItems.slice(0, limit).map(({ _combinedText, ...rest }) => rest);

    // Update cache
    cache = {
      data: payload,
      expiresAt: Date.now() + 5 * MS.minute,
    };

    res.json(payload);
  } catch (err) {
    console.error("❌ RSS processing failed:", err.message || err);
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
      reason: "Reason for the score",
      aisummary: "Short summary from gpt"
    }
  });
});
app.get('/', (req, res) => {
  res.send(" News Sentiment API is live. Use /bbc/rss or /bbc/rss/info.");
});

app.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
});
 
