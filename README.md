# Hotel del Luna Web App

A simple hotel reservation website using a static frontend, a Node.js/Express backend, and Firebase Firestore.

## Architecture

```text
Browser frontend -> Node.js/Express API -> Firebase Admin SDK -> Firestore
```

The browser never connects directly to Firestore. Firestore client rules remain locked down with `allow read, write: if false;`.

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
- `createdAt`: server-generated Firestore Timestamp

### `contact_messages`

- `name`: string
- `email`: string
- `subject`: string
- `message`: string
- `createdAt`: server-generated Firestore Timestamp

There are no `users` or `rooms` collections in this project.

## API routes

- `GET /api/health` - backend health check
- `GET /api/reservations?guestId=...` - retrieve reservations for a browser guest ID
- `GET /api/reservations` - retrieve all reservations
- `POST /api/reservations` - create a reservation
- `DELETE /api/reservations/:id` - delete a reservation
- `POST /api/contact` - submit a contact message
- `GET /api/contact` - retrieve contact messages

## Validation

The backend validates reservation dates, email addresses, guest count, and contact-message length. Reservation dates must use `YYYY-MM-DD`, and check-out must be after check-in.

## Tests

Run the JavaScript syntax check with:

```powershell
npm test
```

The application has also been tested against Firestore through the backend for reservation create/read/delete and contact create/read workflows.

## Current project limitation

The project intentionally does not use Firebase Authentication. The browser-generated `guestId` is a simple demonstration mechanism, not a verified identity system.
