# Hotel del Luna Web App

A simple hotel reservation website using a static frontend, a Node.js/Express backend, and Firebase Firestore.

## Architecture

```text
Browser frontend (public/) -> Node.js/Express API (server/) -> Firebase Admin SDK -> Firestore
```

The browser never connects directly to Firestore. Firestore client rules remain locked down with `allow read, write: if false;`.

## Project layout

```text
public/
  css/       Shared website styles
  images/    Website images
  js/        Browser scripts
  *.html     Public pages and admin pages
server/
  server.js  Express application and API routes
  db.js      Firestore persistence
  auth.js    Request authentication and admin authorization
test/        API and booking tests
```

The Express app serves `public/` at the site root, preserving the existing page and asset URLs. Start the app with `npm start` or `npm run dev`; both use `server/server.js`.

## Requirements

- Node.js
- Firebase project with Firestore enabled
- Firebase service-account JSON stored outside this repository

## Local setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Set the path to the external service-account file or directory:

   ```powershell
   $env:FIREBASE_SERVICE_ACCOUNT_PATH='C:\path\outside\this\repo\service-account.json'
   ```

   The application also accepts a directory containing the service-account JSON file.

3. Start the backend:

   ```powershell
   npm start
   ```

4. Open `http://localhost:3000`.

Never copy the service-account JSON into this repository or commit it to GitHub.

## Firestore collections

### `reservations`

- `guestId`: string
- `name`: string
- `email`: string
- `checkInDate`: `YYYY-MM-DD` string
- `checkOutDate`: `YYYY-MM-DD` string
- `roomName`: string
- `guests`: integer
- `ownerUid`: verified Firebase Authentication UID for authenticated reservations; `null` for anonymous submissions
- `createdAt`: server-generated Firestore Timestamp

### `contact_messages`

- `name`: string
- `email`: string
- `subject`: string
- `message`: string
- `createdAt`: server-generated Firestore Timestamp

There is no `users` collection. Room display details can be stored in `room_information`; document IDs are the fixed slugs `echoing-hall`, `moonview-chamber`, and `celestial-suite`, with only `description` (string) and `priceKrw` (integer) fields. `priceKrw` is the existing API field name; its values are displayed as Philippine pesos. The current defaults are:

| Document ID | Room category | Description | Price per night |
| --- | --- | --- | ---: |
| `echoing-hall` | Echoing Hall | A cozy haven where whispers of the past echo softly through the night. Ideal for guests seeking quiet reflection. | 8636 PHP |
| `moonview-chamber` | Moonview Chamber | Luxurious quarters with panoramic views of the celestial moon garden and a private hanok-style balcony. | 15352 PHP |
| `celestial-suite` | Celestial Suite | The pinnacle of otherworldly luxury, reserved for the most distinguished guests and their unfinished business. With personal attendant | 31184 PHP |

Documents are created or replaced only when an administrator saves a room. Missing documents use these defaults; no collection prepopulation or migration is required. Room categories, room types, amenities, and image references remain fixed in `rooms.html`.

## Booking integrity

The three accepted room categories are `Echoing Hall`, `Moonview Chamber`, and `Celestial Suite`, matching the public reservation form. Each category represents one physical room. The API validates strict `YYYY-MM-DD` calendar dates and reserves check-in inclusive through the night before checkout.

Booking creation uses one Firestore transaction to read the requested category/night claims and existing reservation records, then create the reservation, idempotency record, and all night claims together. Any existing non-cancelled reservation with an overlapping interval blocks the request. A legacy reservation with malformed dates blocks its known category; one with a missing or unknown category blocks all new bookings until the data is reviewed. No legacy records are rewritten.

The transaction scans the reservations collection to preserve safety for records created before night claims existed. This is suitable for the current small project but increases reads and contention as the collection grows; a future controlled backfill/index strategy may be needed.

New claims are stored in `room_night_claims`; idempotency records are stored in `reservation_idempotency`. Both are written atomically with the reservation. These collections are not migrated or pre-populated. The existing reservation deletion path transactionally removes claims belonging to the deleted booking.

`POST /api/reservations` requires an `Idempotency-Key` header containing a UUID. The page generates and retains a key in session storage while retrying the same booking details. Repeating the same key and payload returns HTTP 200 and `Idempotency-Replayed: true`; authenticated retries receive the original reservation, while anonymous retries receive only a generic already-processed acknowledgement and no stored reservation details. Reusing a key for different details returns HTTP 409. Anonymous keys are not proof of identity, and idempotency records are durable and are not automatically expired.

Unexpected booking transaction failures are logged with a sanitized category and allowlisted error code; the API response remains generic. Reservation deletion and cleanup of matching night claims use one Firestore transaction, and claim deletion is conditional on the claim referencing that exact reservation.

## API routes

- `GET /api/health` - backend health check
- `GET /api/reservations` - retrieve the authenticated guest's reservations, or all reservations for an administrator
- `POST /api/reservations` - create a reservation
- `DELETE /api/reservations/:id` - delete the authenticated guest's own reservation, or any reservation for an administrator
- `POST /api/contact` - submit a contact message
- `GET /api/contact` - retrieve contact messages (administrator only)
- `GET /api/rooms` - retrieve public room display information, combining saved values with defaults
- `PATCH /api/rooms/:key` - update an existing room description and displayed price (administrator only)

Booking creation returns 201 after the Firestore transaction commits, 409 for occupied dates or an unsafe legacy record, 400 for invalid input, and 503 when the booking cannot be durably secured.

Protected API requests require an `Authorization` header containing a Firebase ID token using the Bearer scheme. The server verifies the token with Firebase Admin Authentication. Enable the chosen Firebase Authentication sign-in provider and have a client obtain and send a Firebase ID token. Admin access requires the trusted Firebase custom claim `admin: true`; provision this claim only through a trusted server-side/admin process, never from the browser. No admin account creation endpoint is provided.

## Admin dashboard foundation

The administrator sign-in page is `/admin/login`; the dashboard is `/admin`. The browser uses Firebase Authentication email/password sign-in and sends Firebase ID tokens to the existing protected API routes. The dashboard checks the `admin: true` custom claim for user experience, while the server remains responsible for authorization: `GET /api/contact` requires the verified admin claim, and `GET /api/reservations` returns all reservations only to verified administrators (ordinary signed-in users remain limited to their own records).

The dashboard displays reservations with guest, room, stay dates, guest count, and creation time. Search, room-category, and exact check-in-date filters are applied locally to the loaded list. Administrators can edit only a reservation's guest name, email, and guest count through the admin-only `PATCH /api/reservations/:id` endpoint. Reservation identity, ownership, stay dates, room category, availability claims, and idempotency records are not editable through this endpoint. Administrators can also request cancellation through the existing authenticated `DELETE /api/reservations/:id` endpoint after confirming the action.

The admin dashboard also displays contact sender name, email, message, and submission date. Its search filters the already-loaded messages by sender name, email, or message text; contact listing and deletion require a verified administrator claim. Administrators can edit only the description and displayed integer PHP price for the three fixed categories through `PATCH /api/rooms/:key`; category identities, images, and booking behavior are not editable.

Set these public Firebase Web App configuration values in the server environment: `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_AUTH_DOMAIN`, `FIREBASE_WEB_PROJECT_ID`, and `FIREBASE_WEB_APP_ID`. `GET /api/firebase-config` returns only these fields and responds with 503 when they are missing. Firebase Web configuration is public client configuration, not a service-account credential; restrict the API key in Google Cloud as appropriate. The Firebase JS SDK is loaded from Google's CDN.

In Firebase Console, enable the Email/Password sign-in provider and create the intended staff user account(s). A trusted operator must assign `admin: true` to each authorized UID using the Firebase Admin SDK in a secure administrative environment. Do not assign claims from the browser or create an admin-provisioning endpoint. The page itself is not an authorization boundary; the existing server-side ID-token verification and claim checks protect admin data.

The website's public guest booking flow remains anonymous. Reservation history and cancellation still require a signed-in client; legacy records containing only the former browser-generated `guestId` remain unavailable through guest-scoped access until a separate ownership process is designed.

Reservation and contact-message document IDs are generated by the server/data layer; caller-supplied IDs are ignored.

## Validation

The backend validates reservation dates, email addresses, guest count, and contact-message length. Reservation dates must use `YYYY-MM-DD`, and check-out must be after check-in.

## Tests

Run syntax checks plus the API security and booking-integrity tests with:

```powershell
npm test
```

The tests use an in-memory Firestore transaction test double and an injected token verifier. They exercise the production transactional deletion helper, but do not connect to Firestore or verify real Firebase transaction conflict handling or real Firebase ID tokens, and therefore do not replace a Firebase Emulator concurrency test.

Use `npm test` for local API authorization and booking-integrity tests; these use an in-memory mock and do not connect to Firestore.
