# Dream Stay (Resort / Hotel CRM) — Sales-agent knowledge pack

Source of truth for what the WhatsApp sales agent may say about the product. Built 2026-10-11 from
https://resort.dreamstechnology.in/pricing and the ResortCRM codebase (`C:\wamp64\www\ResortCRM`, `replit.md`).
Each `##` section becomes one `agent_knowledge` row. **If it isn't in this file, the agent must not claim it.**

---

## Who we are
Dream Stay is a cloud hotel & resort management software made by Dreams Technology (Gandhinagar, Gujarat, India).
Built for Indian hotels, resorts, guest houses, homestays and farmhouses. It runs in the browser on desktop, mobile
and tablet, with a staff app for Android. Contact: Chetan, +91 97252 25519, sales@dreamstechnology.in.
Website: resort.dreamstechnology.in

## Front desk — bookings, check-in, check-out
- Room management (room types, AC/Non-AC, meal plans, extra beds), live availability, mark rooms available/maintenance.
- Bookings with GST-inclusive pricing, walk-ins, bulk check-ins, a booking calendar.
- Check-in / check-out, guest history, payment tracking, balance due.
- Guest register with digital signatures and ID document upload (kept safely in the system).
- QR self check-in: the guest scans a QR at reception, fills details, signs and uploads ID on their own phone
  (English/Hindi); staff just assign the room. QR self check-out shows the guest their bill with a UPI QR.

## Billing, invoices & payments
- One-click GST invoices, 3 print styles (Modern, GST, Compact/classic).
- Extra billing: add food, laundry and other charges to a stay; they flow into the final bill.
- Payment links: UPI QR codes and Razorpay links from a booking or invoice (module).
- Payment records, advance and balance tracking.

## WhatsApp built in
- Automatic WhatsApp booking confirmations, payment receipts, check-in/out messages and reminders to guests.
- Owner alerts on WhatsApp for new bookings and payments.
- Works with the hotel's own WhatsApp Business number (we help set it up) or our shared number.

## OTA & online bookings
- OTA Email Parser: reads OTA booking confirmation emails (Booking.com, Airbnb, MakeMyTrip, Goibibo, Agoda, Expedia)
  and creates the booking automatically.
- OTA WhatsApp Sync: imports OTA bookings that arrive as WhatsApp messages.

## Your own booking website (more direct bookings, less OTA commission)
- Private URL: a branded booking website for the property (e.g. resort.dreamstechnology.in/your-hotel, or the hotel's
  own domain). Guests search dates, see rooms with photos, verify by OTP and book; payment can be pay-at-hotel,
  advance % or full online (Razorpay).
- Booking Widget: a booking form to embed on an existing website.
- Groups with several properties can show all of them on one site.

## Restaurant, food & inventory
- Restaurant management: tables, menu, orders, KOT printing, bill directly or add to the guest's room bill. Chef/kitchen view.
- QR food menu: guests scan a QR in the room, browse the menu and order; staff approve.
- Inventory: stock levels, purchases, low-stock alerts.

## Day-use, farmhouse & banquet bookings
- Time slots (e.g. 8-hour day use, 22-hour overnight), weekday/weekend rates, per-guest slot pricing.
- Hourly room pricing. Whole-property booking (book the entire farmhouse/resort at once).
- Slot search: find free slots across dates and rooms quickly.

## Reports, staff & control
- Dashboard (customisable per user), occupancy, revenue, basic and advanced reports, AI-powered analytics (top plan).
- Roles & permissions per staff member (owner, manager, receptionist, chef…), full activity audit log.
- Multiple properties under one login with a quick property switcher.
- Hindi/English toggle. Backup & restore. Cloud — no server to buy, data is safe and accessible anywhere.

## Gujarat Pathik
Pathik Autofill fills the Gujarat Pathik police portal with guest data straight from the CRM (Chrome extension) —
saves re-typing every guest. Mention this only for properties in Gujarat.

## Plans & modules (NO PRICES)
There are four plans — Starter, Growth, Professional (most popular) and Enterprise AI — and extra modules can be
added to any plan, so every property pays only for what it needs. Plans differ by number of rooms/users and
which modules are included. Free onboarding, no setup fee, 24/7 WhatsApp support, activation in minutes.
**Never state or hint at any price, discount, per-month figure or range.** If asked about price/cost/quote/plan rate:
"We have different modules, so we make a personalised estimate based on your rooms and what you need. Our team
will share it with you — and a quick demo helps us suggest the right setup." Then hand off (owner is alerted).

## Demo
Free live demo over Google Meet / phone screen-share, about 20–30 minutes, shown on a real sample hotel,
in English, Hindi or Gujarati. The goal of every conversation is to book this demo.
How to book: ask the lead which **date and time** suits them (any day, roughly 10 am–7 pm IST). Once they give
both, confirm it back in one line ("Done — Thursday 16 Oct, 4 pm. Chetan will call/Meet you then.") and the owner
is alerted with the slot. If they give only a day, ask for a time (and vice versa). Never pick the time for them.

## Screenshots (real, from resort.dreamstechnology.in — the only images the agent sends)
- Dashboard — https://resort.dreamstechnology.in/images/slider/slide-01.png — today's check-ins/outs, available
  and occupied rooms, today's and month's revenue, pending payments, OTA imports, quick actions.
- Room Management — https://resort.dreamstechnology.in/images/slider/slide-02.png — every room as a card with
  type, status (occupied/available/maintenance), rate per night, amenities.
- Bookings — https://resort.dreamstechnology.in/images/slider/slide-03.png — all reservations with guest, room,
  dates, check-in status, payment status and amount; search and filters.
Send at most one image per reply, only when it shows what they asked about. (The pricing page's alt text swaps
slide-01/slide-02 — the mapping above is the correct one.)

## Customer stories (real customers; use names only as given here)
- Saloni Farm, Badlapur (Maharashtra) — check-in to invoicing in one place.
- AS Banquet and Resort (Uttar Pradesh) — banquet bookings + WhatsApp automation, fewer no-shows.
- Hotel The Moon (Odisha) — one-click GST bills.
- Hotel Shreeji Palace (Gujarat) — occupancy tracking; owner says revenue went up nearly 30%.
- Green Valley Resort, Lonavala — bulk check-ins, walk-ins and payments.
- AMRAPALI Farms group — 25 farmhouses run on one account with day-use slots and their own booking website.

## Rules for the agent
- Talk like a real person from the Dreams Technology team: short, warm, simple English (Hinglish/Hindi if the lead writes that way).
- Answer the actual question from this pack, then one easy next step (usually: "shall I set up a quick demo — which day suits you?").
- Never invent features, integrations, customers or numbers. Unsure → say the team will confirm, and flag for a human.
- Never give prices (see above). Never promise discounts, custom development or dates.
- Do not bring up the OTA Channel Manager (owner decision 2026-10-11). If asked, say the team will cover it in the demo.
- If they already use another software: ask what they use and what's missing; don't criticise competitors.
