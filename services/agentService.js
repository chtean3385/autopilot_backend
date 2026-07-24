// Compatibility boundary for webhook callers. The channel-agnostic sales pipeline
// lives in salesAgentService and can be reused by future email/SMS adapters.
module.exports = require('./salesAgentService');
