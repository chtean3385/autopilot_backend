// Seed the database with the sample templates and leads from the setup guide.
// Usage: npm run db:seed
const pool = require('../config/db');

const templates = [
  {
    template_name: 'welcome_hotel_owner',
    template_category: 'MARKETING',
    body_text:
      'Hi {{1}},\n\nWe noticed you manage {{2}} in {{3}}! 🏨\n\n' +
      'Hotel management can be overwhelming, but it doesn\'t have to be. Dreams Hotel CRM helps you:\n' +
      '✓ Manage bookings in one place\n✓ Automate guest communication\n✓ Increase occupancy rates\n\n' +
      'Ready for a live demo? Reply with "DEMO" or visit: [link]\n\nBest regards,\nDreams Hotel Team',
    parameters: { param1: 'owner_name', param2: 'hotel_name', param3: 'city' },
    footer_text: 'Dreams Hotel Team',
    status: 'approved'
  },
  {
    template_name: 'followup_interested',
    template_category: 'UTILITY',
    body_text:
      'Hi {{1}},\n\nStill interested in seeing how {{2}} hotels increased bookings by 40%?\n\n' +
      'Let\'s schedule a quick 15-min call:\n📅 [Calendar Link]\n\nTalk soon!\nDreams Team',
    parameters: { param1: 'owner_name', param2: 'hotel_name' },
    footer_text: 'Dreams Team',
    status: 'approved'
  },
  {
    template_name: 'demo_scheduled',
    template_category: 'ACCOUNT_UPDATE',
    body_text:
      'Great! {{1}}, we\'ve scheduled your demo for {{2}}.\n\n' +
      'Here\'s what we\'ll cover:\n✓ Smart booking automation\n✓ Guest communication workflows\n✓ Real-time analytics\n\nSee you soon!',
    parameters: { param1: 'owner_name', param2: 'demo_time' },
    footer_text: null,
    status: 'approved'
  }
];

const leads = [
  {
    hotel_name: 'Grand Hotel Delhi',
    owner_name: 'Raj Kumar',
    email: 'raj@grandhotel.com',
    whatsapp_number: '919876543210',
    city: 'Delhi',
    source: 'manual'
  },
  {
    hotel_name: 'Mumbai Sunrise',
    owner_name: 'Priya Singh',
    email: 'priya@mumbaisunrise.com',
    whatsapp_number: '918765432109',
    city: 'Mumbai',
    source: 'manual'
  }
];

async function seed() {
  try {
    for (const t of templates) {
      await pool.query(
        `INSERT INTO waba_templates
           (template_name, template_category, body_text, parameters, footer_text, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'admin')
         ON CONFLICT (template_name) DO NOTHING`,
        [t.template_name, t.template_category, t.body_text, JSON.stringify(t.parameters), t.footer_text, t.status]
      );
    }
    console.log(`✅ Seeded ${templates.length} templates`);

    for (const l of leads) {
      await pool.query(
        `INSERT INTO hotel_leads
           (hotel_name, owner_name, email, whatsapp_number, city, source)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [l.hotel_name, l.owner_name, l.email, l.whatsapp_number, l.city, l.source]
      );
    }
    console.log(`✅ Seeded ${leads.length} leads`);
  } catch (err) {
    console.error('Seed error:', err.message);
  } finally {
    await pool.end();
  }
}

seed();
