const cors = require('cors');
const app = express();

// Allow all origins (or whitelist your GitHub Pages domain)
app.use(cors({
  origin: '*'
}));
