const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/webhook', require('./routes/webhook'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/agent', require('./routes/agent'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Start background workers
require('./workers/campaignWorker');
require('./services/schedulerService');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`📊 API docs available at http://localhost:${PORT}/api/*`);
});
