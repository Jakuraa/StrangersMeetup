# Organiser Workspace, Event Staff Roles & Secure QR Check-In Architecture (M6)

## 1. Executive Summary

Milestone 6 (M6) delivers an end-to-end operational workspace for event organisers, an event-scoped role and permissions system for venue staff, and a server-authoritative, cryptographically signed QR ticketing engine with a mobile-first door check-in scanner.

Key guarantees:
- **Server Authoritative:** Admission decisions are never made on the client. Every ticket is cryptographically verified and validated against the live database state. Screenshots, client responses, or cached tokens can never forge a valid ticket or fake a check-in.
- **Privacy Preservation:** Ticket QR payloads expose zero attendee personally identifiable information (PII) such as phone numbers, email addresses, names, or predictable database integer IDs.
- **Event-Scoped RBAC:** Staff permissions (`organiser`, `event_manager`, `door_staff`, `guest_list_manager`, `assistant`) are scoped strictly to the assigned event. Revoked staff access terminates immediately.
- **Duplicate & Replay Defense:** Atomic database row locking (`FOR UPDATE OF t`) guarantees that parallel or rapid-fire scans of the same ticket allow exactly one entry, recording any duplicate attempt with timestamp and staff metadata.
- **Immutable Audit Trail:** All scan attempts (valid, duplicate, invalid signature, cross-event, cancelled, or manual override) are permanently appended to the `ticket_scans` table.

---

## 2. Event Staff Roles & Permission Matrix

Event operations are separated from global platform roles. Staff membership is stored in `event_team` with lifecycle status (`active`, `removed`).

| Permission / Action | Organiser (Owner) | Event Manager | Guest-List Manager | Door Staff | Assistant (Read-only) |
|---|:---:|:---:|:---:|:---:|:---:|
| `event.manage` (Dashboard, Overview) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `event.view_inventory` (Capacity, Tiers) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event.view_guests` (Attendee List) | ✅ | ✅ | ✅ | ❌ | ✅ |
| `event.edit` (Title, Timing, Details) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `event.cancel` (Cancel Event) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `event.manage_staff` (Invite / Revoke) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `event.decide_bookings` (Approve / Decline) | ✅ | ✅ | ✅ | ❌ | ❌ |
| `event.cancel_booking` (Cancel Attendee) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `event.announcements` (Post Updates) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `event.check_in` (Door Scanner Admission) | ✅ | ✅ | ✅ | ✅ | ❌ |
| `event.manual_override` (Manager Override) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `event.reissue_ticket` (Replace Pass) | ✅ | ✅ | ❌ | ❌ | ❌ |
| `event.view_audit` (Scan Log History) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Financial Actions (Refunds / Live PG) | ❌* | ❌* | ❌* | ❌* | ❌* |

*\*Financial mutations remain strictly isolated to platform `super_admin` / `finance` roles in `admin_users`. Event staff cannot issue unauthorized monetary transactions or refunds.*

---

## 3. Cryptographic QR Ticket Engine

### 3.1 QR Payload Structure
Each ticket payload conforms to standard format:
```
NLZ1:<ticketCode>:<HMAC-SHA256>
```
Where:
- `NLZ1`: Version identifier.
- `<ticketCode>`: Cryptographically generated 12-character alphanumeric code formatted as `TK-XXXX-XXXX-XXXX` (using `crypto.randomBytes(6)`).
- `<HMAC-SHA256>`: 64-character hexadecimal signature generated with the server ticket secret over `${ticketCode}:${eventId}`.

### 3.2 Security Properties
1. **Zero PII Exposure:** The QR payload contains only the random ticket code and its HMAC signature. No attendee name, phone number, Telegram ID, or database sequence number is present.
2. **Cryptographic Event Binding:** Because the signature is calculated over `${ticketCode}:${eventId}`, a ticket issued for Event A scanned at Event B immediately fails signature verification without requiring a database lookup.
3. **Constant-Time Verification:** Signatures are compared using `crypto.timingSafeEqual` to prevent timing side-channel analysis.
4. **Offline Tamper Prevention:** Any alteration to the ticket code or signature renders the payload invalid.

---

## 4. Door Check-In Experience

### 4.1 Mobile-First Scanner Interface
Staff accessing `/organiser/events/:id/scan` receive a purpose-built scanning interface:
- **Camera Scanning:** Leverages modern browser `BarcodeDetector` API and high-frame canvas fallback to process QR codes directly from the device camera.
- **Manual Lookup Fallback:** If camera access is denied, broken, or hardware-constrained, staff can enter the alphanumeric ticket code (`TK-...`) printed on the attendee pass.
- **Instant Result Badges:**
  - `VALID` (Green): Attendee admitted; displays alias, ticket tier, and pass reference.
  - `ALREADY CHECKED IN` (Yellow): Duplicate scan alert; displays prior check-in timestamp and staff member who performed the initial scan.
  - `CANCELLED / REFUNDED` (Red): Ineligible pass; displays cancellation/refund status.
  - `REVOKED / REISSUED` (Red): Invalid pass replaced by reissued pass.
  - `SIGNATURE MISMATCH` (Red): Forged or altered QR payload.

---

## 5. State Machine & Atomic Concurrency

Tickets transition strictly through server-validated states:

```
[Booking Confirmed]
        │
        ▼
   (valid) ────▶ [reissued] ──▶ (valid - new ticket)
        │
        ├───▶ [cancelled]
        │
        ├───▶ [refunded]
        │
        ▼
  [checked_in]
        │
   (Duplicate attempt rejected with 409 Conflict)
```

### 5.1 Concurrency Defense
Check-in operations run inside an atomic PostgreSQL transaction with row-level locking:
```sql
SELECT t.* FROM tickets t
  JOIN bookings b ON b.id = t.booking_id
 WHERE t.ticket_code = $1
   FOR UPDATE OF t
```
This guarantees that if two staff members or two devices scan the same QR code at the exact same millisecond:
1. One request locks the row, validates that `status === 'valid'`, transitions it to `'checked_in'`, and commits.
2. The concurrent request waits for the lock, reads `status === 'checked_in'`, and is immediately rejected with HTTP 409 `already_checked_in`.

---

## 6. Attendance & Scan Audit Ledger (`ticket_scans`)

Every door interaction appends an immutable record to `ticket_scans`:
- `event_id`: Event UUID.
- `ticket_id`: Target ticket UUID (null if unknown/forged code).
- `scanned_by`: User UUID of the scanning staff member.
- `scan_result`: One of `success`, `already_checked_in`, `ticket_not_found`, `event_mismatch`, `invalid_ticket`, `ticket_revoked`, `ticket_reissued`, `ticket_cancelled`, `ticket_refunded`, `manual_override`.
- `scan_method`: `camera_qr`, `manual_lookup`, or `manual_override`.
- `override_reason`: Required text for manual admission overrides.
- `scanned_payload_hash`: SHA-256 hash of the scanned input.
- `metadata`: JSON context including previous check-in timestamps and attendee tier.

---

## 7. Migration 019 Summary

Schema enhancements applied in `migrations/019_organiser_workspace_and_checkin.sql`:
1. `event_team`: Added audit columns (`updated_at`, `invited_by`, `revoked_by`, `revoked_at`, `notes`) and unique index `uq_event_team_user_active`.
2. `event_staff_invites`: Role-scoped token invitations with TTL expiration.
3. `tickets`: Core ticket ledger storing `ticket_code`, `security_hash`, status, check-in metadata, and reissue/revocation pointers.
4. `ticket_scans`: Append-only scanner audit log.
5. `event_announcements`: Organiser broadcast messages to confirmed attendees.
6. Backfill: Historical confirmed bookings automatically populated into `tickets`.
