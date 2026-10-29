// lib/views/content.js - Copy shared across pages. Answers describe implemented behaviour only.
// NOTE: owner's own 12 FAQ questions were not provided; these are drafts (see docs/SPEC.md).

export const FAQ = [
  {
    q: 'What is StrangersMeetup?',
    a: 'Small, hosted meetups for adults who want to meet new people: dinner clubs, board-game evenings, movie nights, dating mixers, nightlife and weekend trips across Tamil Nadu, Puducherry, Karnataka and Kerala.'
  },
  {
    q: 'Who can join?',
    a: 'Adults aged 21 and over. You confirm your age when you continue with Telegram, and you should carry a photo ID to every event.'
  },
  {
    q: 'How do I book a ticket?',
    a: 'Open an event, choose Book Tickets, continue with Telegram and pay on the payment provider’s secure page. Once the payment is confirmed on our server, our Telegram bot messages you a confirmation and a one-time invite to the event’s private group.'
  },
  {
    q: 'Why do I need Telegram?',
    a: 'Telegram lets you sign in without a password and without sharing your phone number with us. We use it to send your booking confirmation and to give you access to private event groups.'
  },
  {
    q: 'When do I get the venue address?',
    a: 'For events marked “venue shared after booking”, the exact address is posted inside the private Telegram group for confirmed attendees. This protects everyone who is attending.'
  },
  {
    q: 'What is included in a ticket?',
    a: 'Every event page lists exactly what is included and, for trips, what is not. If something is not listed, assume it is not included.'
  },
  {
    q: 'Can I cancel or get a refund?',
    a: 'Each event shows its own refund window. To request a refund, message our bot with /help or use the Contact page. Approved refunds go back to your original payment method through the payment provider. See Billing & Refunds for details.'
  },
  {
    q: 'How does membership work?',
    a: 'Membership is optional and gives access to private members’ Telegram groups. It is paid in Telegram Stars inside Telegram and renews every 30 days until you cancel in Telegram. Prices will be announced soon.'
  },
  {
    q: 'How are payments processed?',
    a: 'Event tickets are paid on a licensed payment gateway’s hosted page, so we never see your card or UPI details. Memberships are paid with Telegram Stars. A booking is only confirmed after the payment provider confirms it to our server.'
  },
  {
    q: 'What data do you keep?',
    a: 'Your Telegram user ID, the display name Telegram shares with us, your city if you give it, and your bookings and payments. We do not ask members for phone numbers or email addresses, and we do not sell personal data.'
  },
  {
    q: 'How do you keep events safe?',
    a: 'Our Community Guidelines apply at every event. Venue details go only to confirmed attendees, group invites are single-use, and anyone who breaks the guidelines can be removed from events and groups.'
  },
  {
    q: 'How do I report someone or something?',
    a: 'Send /report to our Telegram bot or use the Contact page. Reports are reviewed by our moderators. If you are in immediate danger, call 112.'
  }
];

export const HOW_STEPS = [
  ['Discover', 'Browse upcoming meetups and trips by city, date and format.'],
  ['Review', 'Check what is included, the refund policy and how the evening is run.'],
  ['Sign in with Telegram', 'One tap, no password. Confirm you are 21 or older.'],
  ['Book Tickets', 'Pay on a secure, hosted checkout page.'],
  ['Get confirmed', 'Our bot sends your confirmation and a one-time invite to the private group.']
];
