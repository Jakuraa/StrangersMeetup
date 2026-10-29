# Organiser event wizard

Approved organisers create events at `/organiser/new` in four steps: **Basics → Tickets → Features → Preview**.
Nothing goes live until they publish, explicitly, from Preview.

## Who can organise
- A user with `users.organiser_enabled = true`. A super admin grants it:
  `POST /api/admin/organisers { telegram_user_id, enabled }` (audited). The person must have signed in once.
- Active admins with role `super_admin` or `event_manager`.
- Everyone else sees an "apply to host" notice. Drafts and events are owner-scoped, so another organiser's draft returns 404.

## Drafts
- `event_drafts` holds versioned JSON. Saves are `PUT /api/organiser/drafts/:id { data, step, version }`.
  A stale `version` gets 409 `version_conflict` with the newer copy, and the wizard lets the organiser choose a version.
- Draft data is validated loosely when saved (types and lengths). `publishIssues()` in `lib/services/organiser.js`
  is the strict gate, and the same function feeds the inline errors, the Preview checklist and the publish endpoint.
- The browser keeps a localStorage copy of unsaved edits only as a safety net. On load, it is applied only if it was
  based on the server's current version.
- "Start fresh" discards (soft-deletes) the latest draft, after confirmation when it has meaningful content.
- Drafts never appear publicly. An `events` row is created only by `POST /api/organiser/drafts/:id/publish { version, confirm: true }`.

## Tickets and payments
- `ticket_types` holds one row per tier: free or paid, price, quantity, max per booking, optional `valid_on` day for multi-day events, and optional eligibility.
  A DB constraint makes a priced free tier impossible.
- Inventory is checked under the event row lock (`FOR UPDATE`), per event and per tier, so concurrent bookings can't oversell.
- **Paid checkout is off.** `lib/payments/availability.js` reports it unavailable unless `TICKET_CHECKOUT_ENABLED=true`
  *and* provider keys are configured. While it is off:
  - organisers can configure paid tiers and save them;
  - an event whose tiers are *all* paid cannot be published;
  - paid tiers show "Online payment not available yet" and the booking API refuses them with `payment_unavailable`.
- No manual UPI or pay-at-venue flow exists. Nothing a guest does can mark a payment paid. Payments become `paid` only
  via a signature-verified provider webhook or server-side reconciliation, as before. A new provider is an adapter in
  `lib/payments/`; tiers and bookings don't change.
- `bookings.payment_mode` is `free` (no payment ever) or `provider`.

## Features (all persisted in the draft; each switch has real behaviour)
| Feature | Behaviour |
|---|---|
| Ask guests questions | Short, long, single-choice and multiple-choice answers. Required answers are enforced server-side. Answers are visible only to the organiser. |
| Approve each guest | Booking creates `pending_approval` (holds no seat). Approve → free: `confirmed`; paid: checkout with a 24h hold (never "paid"). Decline → `declined`, and that guest can't re-request. |
| Crowd balance | Per-tier eligibility text, which guests must confirm, plus visible "N of M left" counts. Tiers pause at their cap and reopen when a held spot is released. |
| Pickup points | Name, spot and time. Guests must pick one, and it's shown on their booking and the guest list. |
| Event contact | Name and WhatsApp number (normalised to E.164). Shown only on a *confirmed* guest's booking. |

Not implemented, and shown only as "Coming later" with no toggle: minimum guest threshold, promo codes, advance/balance payments and complimentary passes.

## Privacy
With a private venue, the public page, `/api/events`, sitemap, JSON-LD and OG tags show only the area and city.
The address and Google Maps link are returned only by `GET /api/bookings/:id` for the booking's owner once it's confirmed.
Draft images (`/media/event-images/:id`) are visible only to their owner until the event is published.

## Not in scope here
- Editing an event after it's published (organisers manage guests; content edits still go through admin).
- Check-in at the door stays in the existing admin check-in screen.
