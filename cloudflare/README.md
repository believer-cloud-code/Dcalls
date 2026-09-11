# Cloudflare Worker + R2 setup for Dcalls

This directory contains the replacement for the Blaze-only Firebase services.

## What it replaces
- Firebase Cloud Functions -> Cloudflare Worker at `/ai` and `/upload`
- Firebase Storage -> Cloudflare R2 bucket binding named `BUCKET`

## Manual setup steps
1. Install Wrangler if needed:
   npm install -g wrangler
2. Log in:
   wrangler login
3. Update `cloudflare/wrangler.toml` with your bucket name and public URL.
4. Deploy the worker:
   cd cloudflare && wrangler deploy
5. Configure public access to your R2 bucket and set the public base URL:
   - You must provide a public URL that will serve uploaded objects. This can be either:
     - A custom domain you configure in Cloudflare and route to your R2 bucket (recommended), or
     - The account-specific `pub-<account-id>.r2.dev` domain if you enable public access for the bucket.
   - Note: making the bucket publicly reachable is a Cloudflare dashboard/Pages/R2 configuration step — it is not done by the Worker code.
6. Configure Cloudflare Worker variables and secrets:
    - In `cloudflare/wrangler.toml` set `PUBLIC_URL` (or set it in the dashboard) to the public base URL that serves files (no trailing slash).
    - Add `FIREBASE_WEB_API_KEY` as a Worker secret (used for Firebase ID token verification):
       `npx wrangler secret put FIREBASE_WEB_API_KEY`
    - Optionally add AI provider secrets. The Worker prefers providers in this order: GEMINI -> OPENROUTER -> DEEPSEEK.
       - `npx wrangler secret put GEMINI_API_KEY` (if using Gemini)
       - `npx wrangler secret put GEMINI_API_URL` (required when using Gemini)
       - `npx wrangler secret put OPENROUTER_API_KEY` (optional)
       - `npx wrangler secret put DEEPSEEK_API_KEY` (optional)
7. Set the frontend environment variable in `.env.local` to point to your Worker URL (the app uses this to call `/upload`):
   VITE_CLOUDFLARE_WORKER_URL=https://dcalls-worker.<your-subdomain>.workers.dev
8. The app will use the Worker automatically when `VITE_CLOUDFLARE_WORKER_URL` is present. Ensure `cloudflare/wrangler.toml` has the `BUCKET` binding and `PUBLIC_URL` set to the public R2 URL.

## Required secrets
Set these in Cloudflare after deployment if needed:
- FIREBASE_WEB_API_KEY (required)
- GEMINI_API_KEY (optional; set with GEMINI_API_URL)
- GEMINI_API_URL (optional; required if using GEMINI_API_KEY)
- OPENROUTER_API_KEY (optional)
- DEEPSEEK_API_KEY (optional)

## Notes
- Firebase Authentication and Firestore are intentionally left alone.
- The original Firebase Functions and Storage code remains in place until deployment is verified.
