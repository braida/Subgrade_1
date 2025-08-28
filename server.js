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
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; review-sam/1.0)' },
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
  'happy', 'joy', 'excited', 'love',
  'inspired', 'grateful'
  ];
const negativeWords = [
  'sad', 'angry', 'hate'];
const contrastWords = [
  'shocking', 'unbelievable','but','despite'
];
const negativePhrases = [
  "real difficulties", "very difficult"
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
      // Force JSON
      response_format: { type: "json_object" },
    /*
    note:
    You are a bilingual assistant (English & French) that detects bias framing in news text and have two tasks.
Each task is independent.
Task 1/ Neutral mode and do not reference earlier content
a. Principles:
Assess how events or actors are framed, not factual accuracy or stance.
Focus on legitimacy given/denied through language, especially around human suffering, dignity, and moral impact.
Coverage of death, famine, or collapse is a humanitarian lens, not bias.
If politics and suffering both appear, human impact takes priority.
b. Rules:
- Strong factual terms (“killed,” “bombed,” “famine,” etc.) are not bias unless manipulative.
- Flag bias only if there is distortion, misleading omission, or one-sided framing.
- A consistent emphasis (humanitarian, security, economic, etc.) = a lens, not bias.
Provide a very short disclaimer with framing_type to surface the most relevant perspectives it omits - whether technical, ethical, human, cultural, or political.”  don't explain further the reason here.  
Task 2/ aisummary: Evaluate wisdom behind stories analysed completely independent from task 1
**Wisdom AI Take:** Now, switch to the voice of wisdom independent of the previous task, wise and reflective of all text reviewed, This AI evaluate the wisdom in the words used and their meaning in the stories. Give a **short** opinion **please be concise**
Return ONLY valid JSON in this schema: 
 { 
 "bias_score": number, // 0 = no bias, 3 = strong bias 
 "framing_type": string, // e.g. "Humanitarian Crisis", "Conflict and Consequences", "Political Scandal" or other -- AND  **a very short summary please be very concise**
 "confidence_pct": number, // 0-100 
 "reason_summary": string, // Always explain the framing_type and score using this equation format: Signals (textual cues in the text). Heuristics (what Heuristics used for interpretation). Encoded patterns (that impacts your decision and specify the pattern reproduced by writing a full sentences that explain how the pattern is reproduced for this analysis). = framing_type: X vs. Y. Keep short like a worked-out problem
 "aisummary": string, // As per task 2** evaluate the wisdom in the words used and their meaning in the stories. Give your **short** opinion 
}
    */
      messages: [
        {
          role: "system",
          content: `You are a bilingual French and English assistant AI to help assess content interesting topics based on science breakthrough, innovation, impact on society and/or other key elements to assess between 1 neutral to 3 good read.
          Explain your opinion on why the topic is interesting or not so much interesting, depending on the breakthrough and progress discussed **be concise**.
          Suggest 1 to 3 examples of your predictions on this topics potential breakthrough on potential future projects. You don't have to find more than 1 example if any.
          Explain briefly like I'm 5 what's the impact of this topic on society or life or a specific field of study. **be concise**
          
Return ONLY valid JSON in this schema: 
 {
 "bias_score": number, // give your blunt very honest to score how much this topic is interesting from 1 = neutral  to 3 =  good read 
 "framing_type": string, // your blunt unfiltered opinion on why the topic is interesting or not so much interesting if it's redundant and depending on the breakthrough and progress discussed **be concise**. 
 "confidence_pct": number, // 0-100 confidence rate
 "reason_summary": string, // give 1 to maximum = 3 examples of your predictions on high impact projects if any. **please be concise** and try not go over 250/270 caracters.
 "aisummary": string, // also explain briefly like I'm 5 what's the impact of this topic on society, on technology or any specific field. **focus on potential impact and be concise**
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


const MS = { 
  minute: 60_000, 
  hour: 3_600_000, 
  day: 86_400_000, // 1 day
  days3: 86_400_000 * 3 // 3 days
};

// recent check
function isRecent(dateLike, days = 3) {
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
  const days = Math.max(0, parseInt(req.query.days ?? "3", 10) || 3);
  const perSource = Math.max(1, parseInt(req.query.perSource ?? "3", 10) || 3);
  const limit = Math.max(1, parseInt(req.query.limit ?? "25", 10) || 25);

  // cache
  if (cache.data && cache.expiresAt > Date.now()) {
    return res.json(cache.data.slice(0, limit));
  }

  const sources = [
    'https://www.sciencedaily.com/rss/top/science.xml',
    'https://www.newscientist.com/feed/home/',
    'https://news.mit.edu/rss/topic/artificial-intelligence2',
    // 'https://www.frontiersin.org/journals/artificial-intelligence/rss',
    'https://phys.org/rss-feed/science-news/',
    'https://nautil.us/feed/',
    'https://xkcd.com/atom.xml',
    'https://www.geekwire.com/feed/',
    'https://www.futilitycloset.com/feed/',
    'https://www.journaldugeek.com/feed/',
    'https://korben.info/feed.xml'
    

  //  'https://feeds.bbci.co.uk/news/world/rss.xml', 
 //   'https://feeds.skynews.com/feeds/rss/world.xml',
  //  'https://news.un.org/feed/subscribe/en/news/all/rss.xml', 
    // 'https://ir.thomsonreuters.com/rss/sec-filings.xml?items=15', 
  //  'https://www.aljazeera.com/xml/rss/all.xml', 
    // 'https://www.icc-cpi.int/rss/news/all', 
  //  'https://www.rsfjournal.org/rss/current.xml',
  //  'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
  //  'https://www.lemonde.fr/rss/une.xml'
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

    // Get review 
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
  } 
  catch (err) {
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
 
