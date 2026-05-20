<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/977ac06c-1504-4a1a-91f1-9092c0e5604a

## Run Locally

**Prerequisites:**  Node.js

1. Install dependencies:
   `npm install`

2. Copy the environment template and configure your API keys:
   ```bash
   cp .env.local.example .env.local
   ```

3. Edit `.env.local` and add your API keys:
   - **Gemini API Key**: Get from [Google AI Studio](https://ai.google.dev/)
   - **DeepSeek API Key**: Get from [DeepSeek Platform](https://platform.deepseek.com/) (NEW - Primary AI provider)
   - **OpenRouter API Key** (Optional): Get from [OpenRouter](https://openrouter.ai/)
   - **Firebase Credentials**: From your Firebase project settings

4. Run the app:
   `npm run dev`

## Features

### 🤖 AI Integration
- **DeepSeek AI**: Primary AI provider for Damai assistant (real-time translations, summaries, smart replies)
- **Fallback Support**: Automatically falls back to OpenRouter → Gemini if primary fails
- Configure your preferred AI provider in `.env.local`

### 🌐 Web Integration
- **Marketing site** (`Dcalls web/`): Landing at `/welcome.html` — "Get Started" opens the React app
- **React app** (`npm run dev`): Main product at `http://localhost:3000`
- **URLs**: Configure `VITE_APP_URL`, `VITE_MARKETING_URL`, `VITE_HELP_URL` in `.env.local` (see `.env.local.example`)
- **Build**: `npm run build` syncs marketing pages into `dist/` for Firebase Hosting
- **Help Center**: Settings → Help, or `/help.html`

## AI Providers Priority

The app uses the following priority for AI requests:
1. **DeepSeek** (Primary) - Fast and cost-effective
2. **OpenRouter** (Secondary) - Multi-model support
3. **Gemini SDK** (Fallback) - Reliable fallback

If one provider is unavailable or unconfigured, the app automatically tries the next provider.
