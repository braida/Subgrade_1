const path = require('path');
const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');

const app = express();
const parser = new Parser();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));

const positiveWords = [
  'happy', 'joy', 'excited', 'love', 'inspired', 'grateful',
  'amazing', 'proud', 'confident', 'hopeful', 'hope', 'peace', 'palestine', 'freedom', 'great', 'cheerful', 'uplifted',
  'accomplished', 'peaceful', 'motivated', 'encouraged', 'better', 'progress', 'good life',
  'success', 'wins', 'celebrates', 'growth', 'breakthrough', 'improves', 'achieves', 'strong', 'record-high', 'optimistic', 'thriving', 'surges', 'praises', 'boosts', 'innovative',
  'clemency', 'clemence', 'peace', 'peacetalk', 'recognition', 'relief', 'renewed', 'propalestine', 'Pro-Palestinian', 'pro-palestinian'
];

const negativeWords = [
  'sad', 'angry', 'hate', 'depressed', 'frustrated', 'hopeless', 'anxious',
  'scared', 'tired', 'lonely', 'miserable', 'worthless', 'failure', 'afraid',
  'numb', 'crying', 'helpless', 'guilt', 'ashamed', 'stressed',
  'death', 'ache', 'pain', 'grief', 'loss', 'broken', 'suffering', 'unworthy', 'hopelessness', 'mourning', 'war', 'idf', 'israel',
  'crisis', 'fails', 'scandal', 'decline', 'warns', 'crash', 'struggles', 'loss', 'falls', 'controversy', 'outrage', 'disaster', 'accused', 'backlash', 'threat',
  'blockage', 'controversial'
];

const contrastWords = ['epstein', 'shocking', 'unbelievable', 'inspiring', 'devastating', 'huge', 'heartbreaking', 'outrageous', 'promising', 'terrifying', 'major', 'brutal', 'bold', 'remarkable'];
const negativePhrases = ["Ghislane Maxwell", "Epstein", "ghislane maxwell", "epstein", "pro israel", "pro-israelien", "pro-israel", "aid block", "give up", "hate", "suicide", "trauma", "child abuse", "brutality"];

const NEGATIVE_WEIGHT = 1.2;
const PHRASE_PENALTY_PER_MATCH = 1.2;
const CONTRAST_PENALTY_FACTOR = 0.2;

function getSentimentScore(text) {
  let positiveCount = 0;
  let negativeCount = 0;
  const lowerText = text.toLowerCase();

  positiveWords.forEach(word => {
    if (lowerText.includes(word)) positiveCount++;
  });
  negativeWords.forEach(word => {
    if (lowerText.includes(word)) negativeCount++;
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
    if (lowerText.includes(phrase.toLowerCase())) {
      phrasePenalty += PHRASE_PENALTY_PER_MATCH;
    }
  }

  const weightedNegatives = (negativeCount * NEGATIVE_WEIGHT) + phrasePenalty;
  const totalWeighted = positiveCount + weightedNegatives;
  const score = totalWeighted === 0 ? 0 : (positiveCount - weightedNegatives) / totalWeighted;

  console.log({ text, positiveCount, negativeCount, phrasePenalty, score });

  return score;
}

function isRecent(pubDate) {
  if (!pubDate) return false;
  const parsedDate = new Date(pubDate);
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return !isNaN(parsedDate.getTime()) && parsedDate >= sevenDaysAgo && parsedDate <= now;
}


app.get('/bbc/rss', async (req, res) => {
  const sources = [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://rss.cnn.com/rss/edition_world.rss',
    'https://feeds.skynews.com/feeds/rss/world.xml',
    'https://www.aljazeera.com/xml/rss/all.xml'
  ];

  try {
    let allItems = [];

    for (const url of sources) {
      const feed = await parser.parseURL(url);
      const items = feed.items.filter(item => isRecent(item.pubDate)).slice(0, 25); // optional: limit per feed

      const analyzed = items.map(item => {
        const score = getSentimentScore(item.title || item.description || '');
        const emotion = score > 0 ? 'Positive' : score < 0 ? 'Negative' : 'Neutral';
        return {
          source: feed.title,
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
          description: item.contentSnippet || item.content || '',
          sentimentScore: parseFloat(score.toFixed(4)),
          emotion
        };
      });

      allItems = allItems.concat(analyzed);
    }

    allItems.sort((a, b) => b.sentimentScore - a.sentimentScore);
    res.json(allItems.slice(0, 20));
  } catch (error) {
    console.error('❌ Failed to fetch or parse RSS:', error);
    res.status(500).json({ error: 'Failed to load news sources' });
  }
});

    

// Serve static files (e.g., index.html)
app.use(express.static(__dirname));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
