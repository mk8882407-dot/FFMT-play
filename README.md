# FFMT Play Deposit Test Server

This is a fresh, isolated Render service for testing dynamic UPI QR generation and SpacePay payment-link creation. It does not contain or replace the production FFMT backend and it does not credit a wallet.

## Render setup
- Create a NEW Web Service from this folder/repository; do not change the existing FFMT service.
- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node 18+ (Node 20 recommended)

## Environment variables
- `DEPOSIT_UPI_ID` — receiving UPI ID for the dynamic UPI QR
- `DEPOSIT_UPI_NAME` — optional, default `FFMT Play`
- `SPACEPAY_PUBLIC_KEY` — SpacePay public key
- `SPACEPAY_SECRET_KEY` — SpacePay secret key (keep private; never put in Android app)
- `SPACEPAY_REDIRECT_URL` — HTTPS page/URL SpacePay should redirect to after checkout
- `PUBLIC_BASE_URL` — optional public URL of this Render service
- `MIN_DEPOSIT_RUPEES` — optional, default `10`
- `MAX_DEPOSIT_RUPEES` — optional, default `50000`
- `TEST_CUSTOMER_MOBILE` — optional test mobile, default `9999999999`

## Routes
- `GET /api/health`
- `POST /api/deposits/create` body: `{ "amount": 10 }` — returns UPI URI + QR data URL
- `POST /api/spacepay/create` body: `{ "amount": 10, "customerMobile": "9999999999" }` — creates a SpacePay payment URL using `https://api.spacepay.in/v1/pay`
- `POST /api/webhooks/spacepay` — receipt-only diagnostic. Always returns `verified:false`; never credits a wallet.
- `GET /api/test/orders/:orderId` — inspect an in-memory test order
- `GET /api/test/webhook-count` — count webhook receipts

## Important webhook limitation
SpacePay's published `https://spacepay.in/api-docs` page documents `/v1/pay` and `data.result.payment_url`, but does not specify the webhook signature header, exact HMAC algorithm/input, or callback event schema. This test server therefore does not trust callback payloads or mark payments paid. Get the exact webhook contract from SpacePay support before implementing payment verification or wallet crediting.

All order and webhook diagnostic data is stored in memory and disappears when Render restarts/redeploys. Do not use this as production wallet infrastructure.
