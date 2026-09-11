# Dcalls Setup Guide - Cloudflare Worker + R2 Migration

## Overview

This project keeps Firebase Auth and Firestore unchanged, while moving the Blaze-only backend functions to Cloudflare Worker and Storage to Cloudflare R2.

The app should prefer the Worker for AI requests and file uploads once the Cloudflare setup is complete.

---

## 1. Set Up Cloudflare Secrets

Do not place API keys in frontend env files or Git-tracked files.
Create Cloudflare Worker secrets instead:

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put FIREBASE_WEB_API_KEY
```

---

## 2. Set Up the Cloudflare Worker Secrets

This app must not expose AI provider secrets in VITE_ variables.
Use Cloudflare Worker secrets instead:

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put FIREBASE_WEB_API_KEY
```

The Worker reads these directly and never exposes them to the browser.

---

## 3. Frontend env values

Only the Worker URL and R2 public URL belong in frontend env configuration:

```env
VITE_CLOUDFLARE_WORKER_URL=http://localhost:8787
VITE_CLOUDFLARE_R2_PUBLIC_URL=https://<your-r2-public-url>
```

---

## 4. Cloudflare Worker behavior

### AI actions supported by the Worker
- Chat: implemented through DeepSeek/OpenRouter when configured
- Summary: implemented through DeepSeek/OpenRouter when configured
- Transcription: currently requires a provider such as DeepSeek
- TTS: requires a dedicated speech provider and is not enabled by default until one is configured

The app intentionally uses the Worker as the production path, while Firebase Auth/Firestore remain unchanged.

---

## 5. How It Works

### Request Flow
```
User Request
    ↓
[Check DeepSeek] → Available? → Use DeepSeek
    ↓ (Unavailable/Unconfigured)
[Check OpenRouter] → Available? → Use OpenRouter
    ↓ (Unavailable/Unconfigured)
[Check Gemini] → Available? → Use Gemini SDK
    ↓ (All failed)
Error: No AI provider available
```

### Automatic Fallback
- If one provider fails (network error, quota exceeded, etc.), the next provider is tried
- This ensures reliability and uptime
- Users won't experience service interruptions

---

## 6. Features Using AI

### Damai AI Assistant
- **Live Transcription**: Real-time audio transcription
- **Call Summaries**: Automatic bullet-point summaries of conversations
- **Smart Replies**: AI-suggested responses based on typing style
- **Real-time Translation**: Translate messages on the fly
- **Voice Cloning**: Let Damai answer calls

### Web App Integration
- **Get Started Button**: Opens the web app at http://localhost:3000
- **Download Button**: Shows download options for Windows, iOS, and Android
- **Help Center**: Opens help.HTML with support documentation

---

## 7. Troubleshooting

### "No AI provider available" Error
- Check that at least one AI provider secret is set on the Cloudflare Worker
- Verify your API keys are correct
- Check your internet connection

### Slow Responses
- DeepSeek is fastest; ensure the Worker has DEEPSEEK_API_KEY configured
- Check your internet speed
- Consider your API provider's current load

### Rate Limiting Issues
- You may have exceeded your provider's rate limit
- Wait a few minutes before retrying
- Consider upgrading your API plan

### Help Link Not Working
- Ensure help.HTML is in the public folder or served separately
- Check the browser console for errors
- Update the path in SettingsTab.tsx if needed

---

## 8. API Usage & Costs

| Provider | Free Tier | Cost/1M Tokens | Speed |
|----------|-----------|----------------|-------|
| DeepSeek | Yes (10M) | $0.14 | Fast |
| OpenRouter | Yes | Variable | Medium |
| Gemini | Yes (50 req/min) | Free/Premium | Medium |

---

## 9. Next Steps

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Create .env.local**:
   ```bash
   cp .env.local.example .env.local
   ```

3. **Add Your API Keys**:
   Edit `.env.local` and add at least one AI provider key

4. **Run the App**:
   ```bash
   npm run dev
   ```

5. **Test It Out**:
   - Open http://localhost:3000
   - Click "Get Started" to open the web app
   - Go to Damai Tab to test AI features
   - Settings → Help to access documentation

---

## 10. Support & Resources

- **DeepSeek Docs**: https://platform.deepseek.com/docs
- **OpenRouter Docs**: https://openrouter.ai/docs
- **Gemini API Docs**: https://ai.google.dev/docs
- **Dcalls Issues**: Check GitHub issues for common problems
