-- Flag inbound WhatsApp messages that were the business's own auto-responder
-- (greeting/away bot), not a human reply. Set by agentService's GPT classifier;
-- such rows are excluded from the agent's conversation history and never
-- change lead status / demo qualification.
ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS is_auto_reply BOOLEAN DEFAULT FALSE;
