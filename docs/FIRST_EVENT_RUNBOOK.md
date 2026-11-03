# First Revenue Event Runbook: SuperProfile Link-Out

This runbook guides the platform owner through publishing and running the first revenue-generating event on **StrangersMeetup** using the zero-gateway-liability **SuperProfile link-out** mechanism.

---

## Architecture Summary

* **Payment Processing:** 100% handled externally on **SuperProfile**. StrangersMeetup handles zero card data, stores zero payment credentials, and incurs zero gateway compliance liability.
* **Redirection Gate in Production:**
  In `lib/payments/availability.js`, the production redirect is enabled purely by:
  `event.checkout_mode = 'superprofile'` and `Boolean(event.superprofile_url)`.
  * `ENABLE_LIVE_PAYMENTS` is **NOT** required.
  * No secret keys or payment API credentials are required in the app.
* **Venue & Group Delivery:** Handled immediately via SuperProfile's post-purchase confirmation screen and connected Telegram group.
* **Database Tracking (Optional):** When the webhook is active, sales are automatically logged in `orders`. Even without the webhook, Event 1 runs safely because SuperProfile manages ticket stock, attendee payment, and group delivery.

---

## Step-by-Step Owner Instructions

### Step 1: Create the Event Product on SuperProfile
1. Log in to your **SuperProfile** dashboard (https://superprofile.bio).
2. Create a new **Event / Ticket Product**:
   - **Title:** Match your event title (e.g., *Friday Night Social Mixer*).
   - **Price:** Set your ticket price in INR (e.g., ₹499).
   - **Inventory / Capacity:** Set the maximum number of tickets available (e.g., 25).
   - **Post-Purchase Delivery:** Connect your private Telegram group or enter the secret venue details to be revealed upon purchase.
3. **Publish** the product on SuperProfile.
4. Copy the public product link (e.g., `https://superprofile.bio/event/friday-night-mixer`).

---

### Step 2: Publish the Event on StrangersMeetup Admin Console
1. Navigate to `https://strangersmeetup-virid.vercel.app/admin` (or your custom domain).
2. Sign in with your bootstrapped `super_admin` Telegram account.
3. Go to **Events** → **New Event** (or edit an existing draft):
   - **Title, City, Date & Time:** Enter details.
   - **Category:** Choose Nightlife, Dinner, Social Mixer, etc.
   - **Venue Privacy:** Set to **Secret Venue** (renders neighborhood teaser publicly; exact address remains hidden).
   - **Checkout Mode:** Select **SuperProfile**.
   - **SuperProfile Link:** Paste the link copied from Step 1 (`https://superprofile.bio/...`).
   - **Status:** Set to **Published**.
4. Save the event.
5. Verify on `https://strangersmeetup-virid.vercel.app/events/<slug>`:
   - The event displays the **Book Tickets** button.
   - Clicking **Book Tickets** routes through `/checkout/<slug>` and redirects directly to your SuperProfile page with an attached `?ref=...` tracking code.

---

### Step 3: Test Purchase & Refund (Dry-Run)
1. Open the event page in an incognito window or on your mobile device.
2. Click **Book Tickets** and complete a test purchase on SuperProfile using a personal card or UPI.
3. Confirm that:
   - SuperProfile displays the purchase confirmation.
   - You receive the Telegram group invite / secret venue details.
4. In the SuperProfile dashboard, locate your test order and issue a **Refund**.

---

### Step 4: (Optional) Connect Automated Purchase Webhook
To sync SuperProfile purchases into StrangersMeetup's `/admin` Orders table automatically:
1. In Vercel, set a high-entropy secret:
   ```bash
   vercel env add SUPERPROFILE_WEBHOOK_SECRET production
   ```
2. In Zapier, Pabbly, or SuperProfile Webhook settings, configure a webhook trigger for new purchases targeting:
   ```
   POST https://strangersmeetup-virid.vercel.app/api/webhooks/superprofile
   ```
   * Header: `X-SuperProfile-Signature: <hex HMAC-SHA256 of payload>`
   * Payload format:
     ```json
     {
       "event": "payment.success",
       "data": {
         "order_id": "SP-123456",
         "custom_fields": { "ref": "<ref from checkout URL>" },
         "amount": 49900,
         "currency": "INR",
         "buyer_email": "attendee@example.com"
       }
     }
     ```
3. *Note:* If running Event 1 without the webhook, your event still runs smoothly: SuperProfile caps capacity and invites guests to the Telegram group, while you can view your guest list directly in the SuperProfile dashboard.
