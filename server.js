const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');

const app = express();
const parser = new Parser();
app.use(cors());
const PORT = 3001;

const positiveWords = [/* même liste que dans ton JS client */];
const negativeWords = [/* idem */];
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
  if (totalWeighted === 0) return 0;

  return (positiveCount - weightedNegatives) / totalWeighted;
}

app.get('/cnn/rss', async (req, res) => {
  const feed = await parser.parseURL('http://rss.cnn.com/rss/edition.rss');
  const results = feed.items.map(item => {
    const score = getSentimentScore(item.title);
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
});

app.listen(PORT, () => {
  console.log(`✅ RSS backend running at http://localhost:${PORT}`);
});
