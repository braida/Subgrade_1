


const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');

const app = express();
const parser = new Parser();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));

const positiveWords =  [
  'happy', 'joy', 'excited', 'love', 'optimistic', 'inspired', 'grateful',
  'amazing', 'proud', 'confident', 'hopeful','hope','peace','palestine','freedom', 'great', 'cheerful', 'uplifted',
  'accomplished', 'peaceful', 'motivated', 'encouraged', 'better', 'progress', 'good life'
];
const negativeWords = [
  'sad', 'angry', 'hate', 'depressed', 'frustrated', 'hopeless', 'anxious',
  'scared', 'tired', 'lonely', 'miserable', 'worthless', 'failure', 'afraid',
  'numb', 'crying', 'helpless', 'guilt', 'ashamed', 'stressed',
  'death', 'ache', 'pain', 'grief', 'loss', 'broken', 'suffering', 'unworthy', 'hopelessness', 'mourning','war','idf','israel'
];

const contrastWords = ['but', 'however', 'although'];
const negativePhrases = ["don't", "can't", "won't", "shouldn't", "give up", "hate myself", "suicide", "trauma"];

const NEGATIVE_WEIGHT = 2;
const PHRASE_PENALTY_PER_MATCH = 3;

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
          positiveCount = Math.max(positiveCount - 2, 0);
          break;
        }
      }
    }
  }

  let phrasePenalty = 0;
  for (const phrase of negativePhrases) {
    if (lowerText.includes(phrase)) phrasePenalty += PHRASE_PENALTY_PER_MATCH;
  }

  const weightedNegatives = (negativeCount * NEGATIVE_WEIGHT) + phrasePenalty;
  const totalWeighted = positiveCount + weightedNegatives;

  return totalWeighted === 0 ? 0 : (positiveCount - weightedNegatives) / totalWeighted;
}

// ⏱ Only include posts from last 7 days
function isRecent(pubDate) {
  const date = new Date(pubDate);
  const now = new Date();
  const daysAgo = 14;
  const cutoff = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return date >= cutoff;
}

app.get('/cnn/rss', async (req, res) => {
  try {
    const feed = await parser.parseURL('http://rss.cnn.com/rss/edition.rss');
    if (!feed || !feed.items) return res.status(500).json({ error: 'No data' });

    const items = feed.items
      .filter(item => isRecent(item.pubDate))
      .slice(0, 100); // limit for safety

    const results = items.map(item => {
      const score = getSentimentScore(item.title || '');
      const emotion = score > 0 ? 'Positive' : score < 0 ? 'Negative' : 'Neutral';
      return {
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        sentimentScore: score,
        emotion
      };
    });

    results.sort((a, b) => b.sentimentScore - a.sentimentScore);
    res.json(results.slice(0, 10));
  } catch (err) {
    console.error('❌ RSS Error:', err);
    res.status(500).json({ error: 'Failed to fetch CNN RSS feed' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ CNN RSS Sentiment API running.');
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
