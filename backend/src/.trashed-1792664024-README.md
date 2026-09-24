Backend source is in server.ts, auth.ts and storage.ts.
Run:
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
