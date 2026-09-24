# Android APK — phone-friendly cloud build

The mobile app is configured with an EAS preview profile that produces an installable APK.

You need:
1. An Expo account.
2. The backend deployed publicly.
3. `mobile/.env` containing the public API and Socket.IO URLs.
4. EAS CLI or Expo's cloud build flow.

Command-line route:

```bash
cd mobile
npm install
npx eas login
npx eas build:configure
npx eas build -p android --profile preview
```

After the cloud build finishes, EAS provides the APK build artifact.

Do not put backend secrets into `mobile/.env`. Only the public API/socket URLs belong there.
