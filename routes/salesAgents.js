const express = require('express');
const pool = require('../config/db');
const router = express.Router();

const jsonFields = ['tags', 'stage_keys', 'intent_keys', 'examples'];
const optionalText = ['industry', 'sales_strategy', 'qualification_logic', 'demo_process', 'closing_strategy', 'product_knowledge', 'objection_handling', 'response_rules'];

router.get('/', async (_req, res) => {
  try {
    const result = await pool.query(`SELECT a.*, COUNT(k.id)::int AS knowledge_count
      FROM sales_agents a LEFT JOIN agent_knowledge k ON k.agent_id=a.id AND k.active=TRUE
      GROUP BY a.id ORDER BY a.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const [agent, knowledge, intents, stages] = await Promise.all([
      pool.query('SELECT * FROM sales_agents WHERE id=$1', [req.params.id]),
      pool.query('SELECT * FROM agent_knowledge WHERE agent_id=$1 ORDER BY priority DESC, id', [req.params.id]),
      pool.query('SELECT * FROM agent_intent_rules WHERE agent_id=$1 OR agent_id IS NULL ORDER BY priority DESC, id', [req.params.id]),
      pool.query('SELECT * FROM agent_stage_rules WHERE agent_id=$1 ORDER BY stage_order', [req.params.id]),
    ]);
    if (!agent.rows[0]) return res.status(404).json({ error: 'Sales agent not found' });
    res.json({ ...agent.rows[0], knowledge: knowledge.rows, intent_rules: intents.rows, stage_rules: stages.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  if (!body.name?.trim() || !body.system_prompt?.trim()) return res.status(400).json({ error: 'name and system_prompt are required' });
  try {
    const r = await pool.query(`INSERT INTO sales_agents (name,industry,channel,system_prompt,sales_strategy,qualification_logic,demo_process,closing_strategy,product_knowledge,objection_handling,response_rules,active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [body.name.trim(), body.industry || null, body.channel || 'whatsapp', body.system_prompt.trim(), ...optionalText.slice(1).map(k => body[k] || null), body.active !== false]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  const body = req.body || {};
  if (!body.name?.trim() || !body.system_prompt?.trim()) return res.status(400).json({ error: 'name and system_prompt are required' });
  try {
    const r = await pool.query(`UPDATE sales_agents SET name=$1,industry=$2,channel=$3,system_prompt=$4,sales_strategy=$5,qualification_logic=$6,demo_process=$7,closing_strategy=$8,product_knowledge=$9,objection_handling=$10,response_rules=$11,active=$12,updated_at=NOW() WHERE id=$13 RETURNING *`, [body.name.trim(), body.industry || null, body.channel || 'whatsapp', body.system_prompt.trim(), ...optionalText.slice(1).map(k => body[k] || null), body.active !== false, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Sales agent not found' }); res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/knowledge', async (req, res) => {
  const b = req.body || {}; if (!b.title?.trim() || !b.content?.trim()) return res.status(400).json({ error: 'title and content are required' });
  try { const r = await pool.query(`INSERT INTO agent_knowledge (agent_id,title,content,tags,stage_keys,intent_keys,priority,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.params.id,b.title.trim(),b.content.trim(),...['tags','stage_keys','intent_keys'].map(k => JSON.stringify(Array.isArray(b[k]) ? b[k] : [])),Number(b.priority)||0,b.active !== false]); res.status(201).json(r.rows[0]); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/intents', async (req, res) => {
  const b=req.body||{}; if (!b.intent?.trim()) return res.status(400).json({ error: 'intent is required' });
  try { const r=await pool.query(`INSERT INTO agent_intent_rules (agent_id,intent,description,examples,priority,active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,[req.params.id,b.intent.trim().toUpperCase(),b.description||null,JSON.stringify(Array.isArray(b.examples)?b.examples:[]),Number(b.priority)||0,b.active!==false]); res.status(201).json(r.rows[0]); } catch(err){res.status(500).json({error:err.message});}
});

router.post('/:id/stages', async (req, res) => {
  const b=req.body||{}; if (!b.stage_key?.trim() || !b.stage_name?.trim() || !b.objective?.trim()) return res.status(400).json({ error: 'stage_key, stage_name and objective are required' });
  try { const r=await pool.query(`INSERT INTO agent_stage_rules (agent_id,stage_key,stage_name,objective,stage_order,active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,[req.params.id,b.stage_key.trim(),b.stage_name.trim(),b.objective.trim(),Number(b.stage_order)||1,b.active!==false]); res.status(201).json(r.rows[0]); } catch(err){res.status(500).json({error:err.message});}
});

router.delete('/:id', async (req,res) => { try { const r=await pool.query('DELETE FROM sales_agents WHERE id=$1 RETURNING id',[req.params.id]); if(!r.rows[0]) return res.status(404).json({error:'Sales agent not found'}); res.json({success:true}); } catch(err){res.status(500).json({error:err.message});} });

router.put('/:id/knowledge/:knowledgeId', async (req, res) => {
  const b = req.body || {}; if (!b.title?.trim() || !b.content?.trim()) return res.status(400).json({ error: 'title and content are required' });
  try { const r = await pool.query(`UPDATE agent_knowledge SET title=$1,content=$2,tags=$3,stage_keys=$4,intent_keys=$5,priority=$6,active=$7,updated_at=NOW() WHERE id=$8 AND agent_id=$9 RETURNING *`, [b.title.trim(),b.content.trim(),...['tags','stage_keys','intent_keys'].map(k => JSON.stringify(Array.isArray(b[k]) ? b[k] : [])),Number(b.priority)||0,b.active !== false,req.params.knowledgeId,req.params.id]); if (!r.rows[0]) return res.status(404).json({ error: 'Knowledge entry not found' }); res.json(r.rows[0]); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id/knowledge/:knowledgeId', async (req, res) => {
  try { const r = await pool.query('DELETE FROM agent_knowledge WHERE id=$1 AND agent_id=$2 RETURNING id', [req.params.knowledgeId, req.params.id]); if (!r.rows[0]) return res.status(404).json({ error: 'Knowledge entry not found' }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id/intents/:intentId', async (req, res) => {
  const b = req.body || {}; if (!b.intent?.trim()) return res.status(400).json({ error: 'intent is required' });
  try { const r = await pool.query(`UPDATE agent_intent_rules SET intent=$1,description=$2,examples=$3,priority=$4,active=$5 WHERE id=$6 AND agent_id=$7 RETURNING *`, [b.intent.trim().toUpperCase(),b.description||null,JSON.stringify(Array.isArray(b.examples)?b.examples:[]),Number(b.priority)||0,b.active!==false,req.params.intentId,req.params.id]); if (!r.rows[0]) return res.status(404).json({ error: 'Intent rule not found' }); res.json(r.rows[0]); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id/intents/:intentId', async (req, res) => {
  try { const r = await pool.query('DELETE FROM agent_intent_rules WHERE id=$1 AND agent_id=$2 RETURNING id', [req.params.intentId, req.params.id]); if (!r.rows[0]) return res.status(404).json({ error: 'Intent rule not found' }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// stage_key is deliberately not editable here — conversation_memories.current_stage references
// it by value for in-flight leads, so renaming it would strand active conversations.
router.put('/:id/stages/:stageId', async (req, res) => {
  const b = req.body || {}; if (!b.stage_name?.trim() || !b.objective?.trim()) return res.status(400).json({ error: 'stage_name and objective are required' });
  try { const r = await pool.query(`UPDATE agent_stage_rules SET stage_name=$1,objective=$2,stage_order=$3,active=$4 WHERE id=$5 AND agent_id=$6 RETURNING *`, [b.stage_name.trim(),b.objective.trim(),Number(b.stage_order)||1,b.active!==false,req.params.stageId,req.params.id]); if (!r.rows[0]) return res.status(404).json({ error: 'Stage not found' }); res.json(r.rows[0]); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id/stages/:stageId', async (req, res) => {
  try { const r = await pool.query('DELETE FROM agent_stage_rules WHERE id=$1 AND agent_id=$2 RETURNING id', [req.params.stageId, req.params.id]); if (!r.rows[0]) return res.status(404).json({ error: 'Stage not found' }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
