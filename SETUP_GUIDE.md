# Dcalls Setup Guide - DeepSeek, OpenRouter & Gemini Integration

## Overview

Dcalls now supports three AI providers for the Damai AI assistant:
1. **DeepSeek AI** (Primary - Recommended)
2. **OpenRouter** (Secondary - Multi-model)
3. **Gemini API** (Fallback - Reliable)

The app automatically selects the first available provider. Configure as many as you want for redundancy.

---

## 1. Set Up DeepSeek API (Recommended)

### Why DeepSeek?
- Fast response times
- Cost-effective
- Excellent for real-time translations and summaries

### Steps:

1. Visit [DeepSeek Platform](https://platform.deepseek.com/)
2. Sign up for a free account
3. Navigate to **API Keys** in your dashboard
4. Click **Create New API Key**
5. Copy your API key
6. Add to `.env.local`:
   ```
   VITE_DEEPSEEK_API_KEY=sk_your_deepseek_key_here
   ```

---

## 2. Set Up OpenRouter API (Optional - Secondary Provider)

### Why OpenRouter?
- Access to multiple AI models
- Good fallback option
- Excellent for testing different models

### Steps:

1. Visit [OpenRouter.ai](https://openrouter.ai/)
2. Sign up for a free account
3. Go to **Settings** → **API Keys**
4. Create a new API key
5. Copy your API key
6. Add to `.env.local`:
   ```
   VITE_OPENROUTER_API_KEY=sk_your_openrouter_key_here
   ```

---

## 3. Set Up Gemini API (Optional - Fallback Provider)

### Why Gemini?
- Reliable Google-backed AI
- Good fallback when other providers are down
- Free tier available

### Steps:

1. Visit [Google AI Studio](https://ai.google.dev/)
2. Click **Get API Key**
3. Create a new project or select existing
4. Generate API key
5. Copy your API key
6. Add to `.env.local`:
   ```
   VITE_GEMINI_API_KEY=your_gemini_api_key_here
   ```

---

## 4. Complete `.env.local` Example

```env
# Firebase (Required)
VITE_FIREBASE_API_KEY=YOUR_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abcdef123456

# AI Providers (At least one required)
VITE_DEEPSEEK_API_KEY=sk_test_your_deepseek_key
VITE_OPENROUTER_API_KEY=sk_test_your_openrouter_key
VITE_GEMINI_API_KEY=AIza_your_gemini_key

# Optional Settings
VITE_APP_ENV=development
VITE_API_URL=http://localhost:3000
```

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
- Check that at least one API key is set in `.env.local`
- Verify your API keys are correct
- Check your internet connection

### Slow Responses
- DeepSeek is fastest; ensure VITE_DEEPSEEK_API_KEY is configured
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
