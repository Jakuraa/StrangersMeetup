# NIGHTLIFEZ — Master Platform Evolution Architecture Assessment

**Target Repository**: https://github.com/Jakuraa/StrangersMeetup  
**Merged Baseline PR**: #55 (`69f051d5b487071a046dca95b2aeda292df34344`)  
**Working Feature Branch**: `feature/nightlifez-master-platform-evolution`  
**Date**: November 2026  

---

## 1. What Already Exists and Works
- **Dual Authentication**: Real WhatsApp OTP (`lib/services/whatsapp-auth.js`) and Telegram Widget/Login (`lib/telegram/auth.js`) with 5-minute freshness, nonce single-use replay protection, rate limiting, and HMAC-SHA256 signature verification.
- **Session & Identity Isolation**: `users` and `user_identities` map multiple validated providers (WhatsApp, Telegram) to a single user identity without cross-tenant collisions.
- **Organisation & Venue Architecture**: `organisations`, `org_memberships`, `user_capabilities`, `venues`, `event_team` from migrations `012` and `021`, guarded by `can(user, action, target)` in `lib/services/permissions.js`.
- **Event Creation & Ticketing Engine**: Draft builder, multi-tier pricing, check-in scanning, booking approvals, and immutable payment snapshots.
- **City Intelligence**: Canonical directory of 49 Indian cities across primary, expansion, and getaway markets (`027_master_auth_onboarding_neon.sql`).
- **Media Cleanup Core**: `lib/services/media-lifecycle.js` contains PostgreSQL advisory locking (`MEDIA_CLEANUP_LOCK_ID = 749201`), candidate scanning, and dependency checking protecting active bookings and legal holds.

---

## 2. What Can Be Reused
- Existing `users`, `user_identities`, `organisations`, `venues`, `events`, `bookings`, `tickets`, and `payments` tables and services.
- WhatsApp OTP delivery and notification dispatch pipeline (`notification_messages`).
- Authorization framework (`permissions.js`), ensuring server-side tenant isolation.
- Core booking check-in and QR ticket validation handlers.
- Location search, alias matching, and coordinate bounds lookup services.

---

## 3. What Must Change
1. **Design System & Visual Identity**:
   - Replace the overly dark, near-black styling (`#090B16`) with a vibrant, luminous nightlife palette: rich indigo anchor, electric violet, warm coral/pink, sunset orange, fresh aqua, soft lavender, and luminous card surfaces.
   - Refine WCAG 2.2 AA contrast, accessible focus rings, and responsive touch targets.
   - Redesign homepage: replace Telegram-dominant banners with an energetic experiences carousel, multi-category shelves, and friendly empty states.
2. **Balanced Dual Authentication**:
   - Make WhatsApp and Telegram equally prominent on `/signin` and in header navigation.
   - Replace "Continue with Telegram" header button with neutral "Sign In" linking to `/signin`.
   - Remove "Get event alerts on Telegram" homepage CTAs and Telegram-exclusive marketing copy.
   - Support international phone numbers with default +91 country code pill in WhatsApp login.
3. **Account Capabilities & Self-Service Switching**:
   - Allow any user to act as an Attendee, a Business operator, or both on a single identity.
   - Provide a dynamic workspace switcher in navigation ("Switch to Business" / "Switch to Attendee").
4. **First-Time Guided Onboarding**:
   - Multi-step, screen-by-screen onboarding for both Attendees (8 screens) and Business (10 screens).
   - Attendee: Welcome (21+ age consent) -> Account Type -> Profile -> City/Location -> Interests (33 experiences) -> Experience Preferences -> Privacy -> Completion.
   - Business: Welcome -> Business Type -> Profile & Bio -> Operating Cities -> Brand Media -> Services & Capabilities -> Contact -> Team -> Preview -> Launch.
5. **Unified Business Dashboard (`/business`)**:
   - Replace disjointed `/organiser` and `/venue` portals and legacy application forms with a single command center featuring Overview, Events, Bookings & Attendees, Venues, Hosts & Team, Suppliers & Partners, Analytics, and Settings modules.
6. **Attendee Dashboard (`/me`)**:
   - Hub featuring My Passes & Bookings, Saved Events, Notifications, Connections (with privacy controls), Profile, and Explainable Recommendation Preferences.
7. **Event Lifecycle & Safe Media Cleanup**:
   - Add explicit event cancellation with mandatory reason capture and attendee notice.
   - Add safe event soft-deletion with dependency protection.
   - Enable on-demand and scheduled event media cleanup with dry-run preview and audit logging.
8. **Retire Waiting-List Experience**:
   - Redirect `/become-a-host`, `/list-your-venue`, and `/partner-with-us` to self-service business onboarding while maintaining lead history.

---

## 4. Database and API Dependencies
- **New Migration `028_master_platform_evolution.sql`**:
  - `user_preferences`: Attendee discovery settings (group sizes, preferred times, event types).
  - `user_connections`: Mutual attendee networking with privacy safeguards.
  - `business_workspaces`: Workspace entities linked to `organisations` with business types, cover image, and self-service status.
  - `business_suppliers`: Supplier & partner service listings.
  - `event_cancellations`: Cancellation audit records with reason and actor tracking.
  - `media_cleanup_jobs`: Cleanup job tracking with dry-run and execution logs.
  - Extend `users` with `active_account_mode` ('attendee' | 'business').

---

## 5. Security and Migration Risks
- **Tenant Isolation**: Every business endpoint enforces organizational membership checks; venue managers and suppliers never access unrelated organizer data.
- **Attendee PII Protection**: Attendee phone numbers and Telegram handles are strictly hidden from other attendees and unapproved partners.
- **Zero Data Loss**: Migration is 100% additive with `IF NOT EXISTS` guards. Existing user bookings, payments, and events remain untouched.

---

## 6. Storage and Infrastructure Costs
- Media is stored in PostgreSQL `event_images` as BYTEA (up to 2MB).
- Media cleanup reclaims database storage for completed events past the 30-day grace period while retaining core event and financial audit records.

---

## 7. Implementation Sequence
1. Database migration `028_master_platform_evolution.sql`.
2. Design system tokens & stylesheet updates (`public/css/site.css`).
3. Navigation and layout updates (`lib/views/layout.js`, `lib/views/home.js`, `lib/views/components.js`).
4. Equal dual authentication presentation (`lib/views/pages.js`, `public/js/site.js`).
5. Attendee & Business guided onboarding (`lib/services/member-onboarding.js`, `lib/handlers/onboarding.js`, `lib/views/pages.js`).
6. Attendee dashboard (`/me`) enhancements (`lib/views/pages.js`, `public/js/site.js`, new API endpoints).
7. Unified Business dashboard (`/business`) (`lib/handlers/business.js`, `lib/views/business.js`, `lib/services/business.js`).
8. Event lifecycle (cancellation, soft-deletion) and media cleanup worker.
9. Retirement of waiting-list forms in favor of self-service.
10. Full verification (Lint, Unit, Integration, Playwright, responsive checks).
