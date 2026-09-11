Platform build instructions — Dcalls

This file describes how to prepare and build the app for Android, iOS, and desktop (Windows/Linux) using the current repository.

Prerequisites (general)
- Node.js 18+ and npm
- Java JDK 11+ (for Android Gradle builds)
- Android SDK + Android Studio (for Android)
- Xcode 15+ on macOS (for iOS build)
- Electron build dependencies (for desktop): native build tools on Linux/Windows
- Firebase project configured for the app (set `VITE_API_BASE_URL` and function envs as needed)

Common web build
1. Install dependencies:

```bash
npm install
```

2. Build the web assets:

```bash
npm run build
```

Android (Capacitor)
1. Prepare and sync Capacitor files:

```bash
npm run prepare:capacitor
```

2. Open Android Studio (recommended) or use Gradle:

```bash
# Open in Android Studio
npx cap open android

# or build with Gradle (Linux/macOS)
cd android && ./gradlew assembleRelease
```

Notes:
- Ensure `android/gradle.properties` and `android/app/build.gradle` are correctly configured (signing, versionCode, versionName).
- Set environment variables for any secrets (TURN servers) locally and do not commit them.

iOS (Capacitor)
- Requires macOS with Xcode installed.

1. Prepare Capacitor iOS assets and sync:

```bash
npm run prepare:ios
npx cap open ios
```

2. Open `ios/App/App.xcworkspace` in Xcode and archive for release.

Desktop (Electron)
1. Build the web app first:

```bash
npm run build
```

2. Build Electron packages (uses `electron-builder`):

```bash
# Build for current OS
npm run build:desktop

# Build Linux AppImage explicitly
npx electron-builder --linux

# Build Windows NSIS explicitly (requires Windows or Wine tooling)
npx electron-builder --win
```

Notes and caveats
- iOS builds must be performed on macOS.
- Android builds require a configured `ANDROID_HOME` and SDK. Use Android Studio to manage SDKs and signing keys.
- Desktop Windows builds may require building on Windows or using Wine/CI.
- Ensure `VITE_API_BASE_URL` is set in your environment (or `.env.local`) before building so the web assets reference the correct backend.

Environment variables to set (example in your shell before building):

```bash
export VITE_API_BASE_URL=https://us-central1-YOUR-PROJECT.cloudfunctions.net
export VITE_TURN_URL=turn:turn.example.com
export VITE_TURN_USERNAME=turnuser
export VITE_TURN_CREDENTIAL=turnpass
# For functions, set provider keys in the functions environment
# e.g., DEEPSEEK_API_KEY, OPENROUTER_API_KEY
```

CI recommendation
- Use separate CI pipelines for mobile and desktop builds.
- For Android: use GitHub Actions with setup-java and Android SDK, or use Google Play App Signing.
- For iOS: use GitHub Actions macOS runners or Fastlane on macOS.
- For desktop: use electron-builder in CI with appropriate environment and signing credentials.

If you want, I can:
- Attempt a local Android Gradle build here (requires Android SDK installed on this machine). I can detect SDK presence and run the build if available.
- Produce Fastlane or CI examples for automated builds.
