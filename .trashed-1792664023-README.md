# Real-time Chat App — completed starter

This version is prepared as a practical MVP for Android testing.

## Included

- Email/password registration and login
- Guest testing account
- Persistent JWT session
- User list and chat list
- Search users
- User avatar display
- Online/offline presence through Socket.IO
- Real-time text messages
- Sent / delivered / read status
- Message history pagination
- Auto-scrolling chat behavior
- Multiline composer
- Image, video and document picker
- Upload progress
- Image preview
- Native video player
- Document/file cards with open/download behavior
- PostgreSQL + Prisma persistence
- S3-compatible object storage
- 20 MB normal-file limit
- 50 MB MP4/WebM video limit
- Backend authorization checks

## Important

The app code is complete as an MVP, but a real production deployment still needs your own cloud services:
PostgreSQL, S3-compatible storage, a public backend URL, and an Expo/EAS account for cloud Android builds.

Never put passwords, JWT secrets, database credentials, S3 keys, or private keys into chat.

## Backend

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run build
npm start
```

Create `backend/.env` from `.env.example`.

## Android

Create `mobile/.env` from `.env.example`:

```env
EXPO_PUBLIC_API_URL=https://YOUR-BACKEND-DOMAIN
EXPO_PUBLIC_SOCKET_URL=https://YOUR-BACKEND-DOMAIN
```

For local testing, replace the domain with the computer's LAN IP.

## APK

Use EAS cloud build:

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build -p android --profile preview
```

The preview profile is configured to produce an APK.

## Security notes

For production, add rate limiting, refresh-token rotation, signed/private object URLs,
virus scanning, abuse controls, push notifications, retry/background upload handling,
and stricter file-content validation. These are deployment hardening items, not blockers
for the MVP test build.
