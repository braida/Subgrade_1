
const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');

const app = express();
const parser = new Parser();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));

const positiveWords = [
  'happy', 'joy', 'excited', 'love', 'optimistic', 'inspired', 'grateful',
  'amazing', 'proud', 'confident', 'hopeful','hope','peace','palestine','freedom', 'great', 'cheerful', 'uplifted',
  'accomplished', 'peaceful', 'motivated', 'encouraged', 'better', 'progress', 'good life',
  'success', 'wins', 'celebrates', 'growth', 'breakthrough', 'improves', 'achieves', 'strong', 'record-high', 'optimistic', 'thriving', 'surges', 'praises', 'boosts', 'innovative',
  'clemency','clemence', 'peace', 'peacetalk', 'recognition','relief', 'renewed','propalestine','Pro-Palestinian'
];

const negativeWords = [
  'sad', 'angry', 'hate', 'depressed', 'frustrated', 'hopeless', 'anxious',
  'scared', 'tired', 'lonely', 'miserable', 'worthless', 'failure', 'afraid',
  'numb', 'crying', 'helpless', 'guilt', 'ashamed', 'stressed',
  'death', 'ache', 'pain', 'grief', 'loss', 'broken', 'suffering', 'unworthy', 'hopelessness', 'mourning','war','idf','israel',
  'crisis', 'fails', 'scandal', 'decline', 'warns', 'crash', 'struggles', 'loss', 'falls', 'controversy', 'outrage', 'disaster', 'accused', 'backlash', 'threat',
  'blockage', 'controversial'
];

const contrastWords = ['shocking', 'unbelievable', 'inspiring', 'devastating', 'huge', 'heartbreaking', 'outrageous', 'promising', 'terrifying', 'major', 'brutal', 'bold', 'remarkable'];
const negativePhrases = ["Ghislane Maxwell","Epstein","pro israel", "pro-israelien", "pro-israel","aid block", "give up", "hate", "suicide", "trauma","child abuse", "brutality"];

const NEGATIVE_WEIGHT = 1.2;
const PHRASE_PENALTY_PER_MATCH = 1.2;
const CONTRAST_PENALTY_FACTOR = 0.5;

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
    if (lowerText.includes(phrase)) phrasePenalty += PHRASE_PENALTY_PER_MATCH;
  }

  const weightedNegatives = (negativeCount * NEGATIVE_WEIGHT) + phrasePenalty;
  const totalWeighted = positiveCount + weightedNegatives;
  return totalWeighted === 0 ? 0 : (positiveCount - weightedNegatives) / totalWeighted;
}

function isRecent(pubDate) {
  if (!pubDate) return false;
  const parsedDate = new Date(pubDate);
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return !isNaN(parsedDate.getTime()) && parsedDate >= sevenDaysAgo && parsedDate <= now;
}

app.get('/bbc/rss', async (req, res) => {
  try {
    const feed = await parser.parseURL('http://feeds.bbci.co.uk/news/world/rss.xml');
    const items = feed.items.filter(item => isRecent(item.pubDate)).slice(0, 100);
    const results = items.map(item => {
      const score = getSentimentScore(item.title || '');
      const emotion = score > 0 ? 'Positive' : score < 0 ? 'Negative' : 'Neutral';
      return {
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        description: item.contentSnippet || item.content || '',
        sentimentScore: score,
        emotion
      };
    });

    results.sort((a, b) => b.sentimentScore - a.sentimentScore);
    res.json(results.slice(0, 10));
  } catch (error) {
    console.error('❌ Failed to fetch or parse BBC RSS:', error);
    res.status(500).json({ error: 'Failed to load BBC RSS feed' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ BBC World News Sentiment API is running.');
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
