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

//store
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./articles.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    link TEXT,
    pubDate TEXT,
    source TEXT,
    sentimentScore REAL,
    confidence REAL,
    emotion TEXT,
    reason TEXT,
    aisummary TEXT,
    savedAt TEXT
  )`);
});


// Trend summary cache
db.run(`
  CREATE TABLE IF NOT EXISTS trend_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generatedAt TEXT NOT NULL,
    summary TEXT,
    topics TEXT,
    insight TEXT,
    examples TEXT
  )
`);

//

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
          messages: [
        {
          role: "system",
          content: `You are neutral, and bluntry honest bilingual French and English responding in english to help assess content interesting topics, rate based on: [general knowledge, impact onscience or social breakthrough, innovation] and/or other key elements to assess between 1 (neutral) to 3 (good read).
          Explain your opinion and be critical but fair about if the topic is interesting or not so much interesting, depending on the topic discussed. **Please be concise**.
          Suggest 1 to 3 examples of your predictions on this topic's potential social and or science impact. You don't have to find more than 1 example if any.
          Explain briefly like I'm 5 what's the article about. **Please be concise**
          
Return ONLY valid JSON in this schema: 
 {
 "bias_score": number, //  be very honest and blunt score for how much this topic is interesting from 1 = neutral  to 3 =  very good read 
 "framing_type": string, // Why is interesting or not so much so, give your blunt critical opinion about if the topic is interesting or not so much interesting  **be concise**. rate based on: [general knowledge, science or social breakthrough, innovation] 
 "confidence_pct": number, // 0-100 confidence rate
 "reason_summary": string, // give 1 to maximum = 3 examples of your predictions on this topic's impact if any. **please be concise** and try not go over 250/270 caracters.
 "aisummary": string, // explain briefly like I'm 5 what's this article about and impact on society or related field **Please be concise**
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

async function getRecentArticlesSummary(articles = []) {
  if (!Array.isArray(articles) || articles.length === 0) {
    throw new Error("No articles provided for summary.");
  }

  const summaryText = articles.map((item, idx) =>
    `${idx + 1}. ${item.title}: ${item.description}`
  ).join('\n\n');

  try {
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.5,
      
      messages: [
        {
          role: "system",
          content: `You are a smart AI assistant bilingual in French and English responding in english and help to summarize and be very concise. 
          Read all articles and give the recent articles, Look for Emerging Trends, high impact topics ** Be neutral with sharp opinion**
          You can identify humour and sadness and emergency in articles. **You can give a brief summary** . **Please be very concise**.
          `
        
        },
        {
          role: "user",
          content: summaryText
        }
      ]
    });

    const content = aiResponse.choices?.[0]?.message?.content?.trim();
    return content || "No summary available.";

  } catch (err) {
    console.error("❌ GPT-4o Mini summary failed:", err.message || err);
    return "Summary generation failed.";
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
  days3: 86_400_000 * 2 // 2 days
};

// recent check
function isRecent(dateLike, days = 2) {
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


// store review 
 function saveArticlesToDatabase(articles) {
  const stmt = db.prepare(`
    INSERT INTO articles 
    (title, link, pubDate, source, sentimentScore, confidence, emotion, reason, aisummary, savedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();

  for (const a of articles) {
    stmt.run([
      a.title,
      a.link,
      a.pubDate,
      a.source,
      a.sentimentScore ?? null,
      a.confidence ?? null,
      a.emotion ?? null,
      a.reason ?? null,
      a.aisummary ?? null,
      now
    ]);
  }

  stmt.finalize();
  console.log(` 👍🏻Saved ${articles.length} articles to DB.`);
}
//



app.get('/bbc/rss', async (req, res) => {
  // Query params: ?days=1&perSource=3&limit=15
  const days = Math.max(0, parseInt(req.query.days ?? "3", 10) || 3);
  const perSource = Math.max(1, parseInt(req.query.perSource ?? "3", 10) || 3);
  const limit = Math.max(1, parseInt(req.query.limit ?? "25", 10) || 30);

  // cache
  if (cache.data && cache.expiresAt > Date.now()) {
    return res.json(cache.data.slice(0, limit));
  }

  const sources = [
    'https://www.sciencedaily.com/rss/top/science.xml',
    'https://www.newscientist.com/feed/home/',
   // 'https://news.mit.edu/rss/topic/artificial-intelligence2',
    'https://www.nasa.gov/news-release/feed/',
   // 'https://phys.org/rss-feed/science-news/',
    'https://nautil.us/feed/',
 //   'https://xkcd.com/atom.xml',
    'https://www.geekwire.com/feed/',
    'https://www.futilitycloset.com/feed/',
  // 'https://www.journaldugeek.com/feed/',
    'https://korben.info/feed.xml',
    

    'https://feeds.bbci.co.uk/news/world/rss.xml', 
   // 'https://feeds.skynews.com/feeds/rss/world.xml',
  //  'https://news.un.org/feed/subscribe/en/news/all/rss.xml', 
    // 'https://ir.thomsonreuters.com/rss/sec-filings.xml?items=15', 
   // 'https://www.aljazeera.com/xml/rss/all.xml', 
    // 'https://www.icc-cpi.int/rss/news/all', 
  //  'https://www.rsfjournal.org/rss/current.xml',
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

    // Get review 
    const chunkSize = 8;
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
//store
    saveArticlesToDatabase(payload);
    
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

app.get('/bbc/rss/summary', async (req, res) => {
  try {
    const articles = cache?.data || [];
    if (articles.length === 0) {
      return res.status(503).json({ error: "No cached data available. Please fetch /bbc/rss first." });
    }

    const top5 = articles.slice(0, 3); // updated 3 articles
    const summary = await getRecentArticlesSummary(top5);

    res.json({
      summary,
      basedOn: top5.map(({ title, link }) => ({ title, link }))
    });

  } catch (err) {
    console.error("❌ Summary route error:", err.message || err);
    res.status(500).json({ error: "Failed to generate summary." });
  }
});


//store root
app.get('/bbc/rss/trends', (req, res) => {
  const sinceDate = new Date(Date.now() - 7 * 86400 * 1000).toISOString(); // last 7 days

  db.all(
    `SELECT title FROM articles WHERE savedAt >= ?`,
    [sinceDate],
    (err, rows) => {
      if (err) {
        console.error("❌ DB error:", err.message);
        return res.status(500).json({ error: "Trend query failed" });
      }

      const wordCounts = {};
      rows.forEach(row => {
        const words = (row.title || '').toLowerCase().split(/\W+/);
        for (const word of words) {
          if (word.length < 4) continue;
          wordCounts[word] = (wordCounts[word] || 0) + 1;
        }
      });

      const topWords = Object.entries(wordCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({ word, count }));

      res.json({
        total_titles: rows.length,
        top_words: topWords,
        generatedAt: new Date().toISOString()
      });
    }
  );
});
//

    // trend analysis + cache
app.get('/bbc/rss/trends/gpt', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd

  // Check cache for today's summary
  db.get(
    `SELECT * FROM trend_summaries WHERE generatedAt LIKE ? LIMIT 1`,
    [`${today}%`],
    async (err, row) => {
      if (err) {
        console.error("❌ DB read error:", err.message);
        return res.status(500).json({ error: "DB lookup failed." });
      }

      if (row) {
        // ✅️ Return cached summary
        return res.json({
          cached: true,
          generatedAt: row.generatedAt,
          summary: row.summary,
          topics: JSON.parse(row.topics),
          insight: row.insight,
          examples: JSON.parse(row.examples)
        });
      }

      // No cache / build summary
      const sinceDate = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

      db.all(
        `SELECT title, sentimentScore, reason, aisummary,pubDate FROM articles WHERE savedAt >= ?`,
        [sinceDate],
        async (err, rows) => {
          if (err || !rows.length) {
            return res.status(500).json({ error: "No data for trend summary." });
          }

          const summaries = rows.map(r => `• ${r.title} — ${r.aisummary ?? 'N/A'} | ${r.reason ?? ''} | ${r.pubDate ?? ''}`).slice(0, 25);

          const prompt = `
You are an AI assistant bilingual in French and English responding in english that identifies **weekly trends in the news**. 
From the list of article summaries below, do the following:
- Identify trends in the articles and highlight the most interesting topics with title articles, the number of times the topic is mentioned and **Context if you have any**",
- Summarize the **top 3 discussed topics** and give example of the title article published this week and publication date (if any). 
- Give a short insight into **why people may care**
- Optional: list notable examples or projects

Return JSON like:
{
  "summary": "identify trends in the articles and highlight the most interesting topics,with title articles, the number of times the topic is mentioned and Context if you have any",
  "topics": ["Topic A", "Topic B", "Topic C"],
  "insight": "Why are these topics trending? is there repeated mentions of this topic. give your blunt opinion and be concise",
  "examples": ["Optional notable article or project"]
}
Articles:
${summaries.join('\n')}
`;
          try {
            const completion = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              temperature: 0.4,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: "You are a bilingual in french and english trend analyst for weekly news articles.Be impartial and blunt to Detect **recurring themes and topics** amd give a few titles over the week" },
                { role: "user", content: prompt }
              ]
            });

            const response = completion.choices[0].message.content;
            const parsed = JSON.parse(response);

            // Save to DB
            db.run(
              `INSERT INTO trend_summaries (generatedAt, summary, topics, insight, examples) VALUES (?, ?, ?, ?, ?)`,
              [
                new Date().toISOString(),
                parsed.summary,
                JSON.stringify(parsed.topics),
                parsed.insight,
                JSON.stringify(parsed.examples || [])
              ]
            );

            // Return fresh result
            res.json({
              cached: false,
              generatedAt: new Date().toISOString(),
              ...parsed
            });

          } catch (e) {
            console.error("❌ GPT trend failed:", e.message || e);
            res.status(500).json({ error: "Trend summary GPT call failed." });
          }
        }
      );
    }
  );
});
// end 


        
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
 
