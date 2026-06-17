<div align="center">
  <img width="1200" height="475" alt="Dcalls Banner" src="" />
</div>

# Dcalls

> AI-powered communication platform for messaging, voice calls, video calls, collaboration, and intelligent assistance.

Dcalls combines real-time communication with artificial intelligence to create a modern platform where users can chat, make calls, share content, and interact with the powerful **Damai AI Assistant**.

---

## ✨ Features

### 💬 Messaging

* Real-time private messaging
* Chat history synchronization
* Read and delivery status
* Media and file sharing
* Fast cloud synchronization

### 📞 Calling

* Voice calling
* Video calling
* WebRTC-powered communication
* Call logs and history
* Real-time call notifications

### 🤖 Damai AI Assistant

* Intelligent conversations
* Smart suggestions and replies
* Language translation
* Content summarization
* Productivity assistance
* Multi-provider AI support

### ☁️ Cloud Powered

* Firebase Authentication
* Cloud Firestore
* Firebase Hosting
* Real-time synchronization

### 📱 Modern Experience

* Responsive design
* Progressive Web App support
* Cross-device synchronization
* Mobile-friendly interface

---

## 🧠 AI Architecture

Dcalls uses multiple AI providers to maximize reliability and availability.

### AI Provider Priority

1. **DeepSeek** (Primary)
2. **OpenRouter** (Secondary)
3. **Google Gemini** (Fallback)

If one provider becomes unavailable, Dcalls automatically attempts the next available provider.

### Supported AI Features

* Conversational assistance
* Smart suggestions
* Translation
* Summarization
* Productivity support
* Context-aware responses

---

## 🏗️ Technology Stack

### Frontend

* React
* TypeScript
* Vite
* Tailwind CSS

### Backend

* Firebase Authentication
* Cloud Firestore
* Firebase Hosting
* Firebase Cloud Functions

### Real-Time Communication

* WebRTC
* Firestore Signaling

### AI Services

* DeepSeek API
* OpenRouter API
* Google Gemini API

---

## 📁 Project Structure

```text
Dcalls/
├── src/
├── public/
├── functions/
├── electron/
├── dataconnect/
├── Dcalls web/
├── firebase.json
├── firestore.rules
├── package.json
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

Install:

* Node.js 18+
* npm
* Firebase CLI (optional)

---

## 📦 Installation

Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/Dcalls.git
cd Dcalls
```

Install dependencies:

```bash
npm install
```

---

## ⚙️ Environment Setup

Create a local environment file:

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and configure the following values.

### AI Providers

```env
VITE_DEEPSEEK_API_KEY=
VITE_OPENROUTER_API_KEY=
VITE_GEMINI_API_KEY=
```

### Firebase

```env
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

### Application URLs

```env
VITE_APP_URL=
VITE_MARKETING_URL=
VITE_HELP_URL=
```

---

## ▶️ Running Locally

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

---

## 🌐 Marketing Website

The repository includes a standalone marketing website.

Location:

```text
Dcalls web/
```

Landing page:

```text
/welcome.html
```

The **Get Started** button launches the main React application.

---

## 🏗️ Build for Production

Create a production build:

```bash
npm run build
```

Preview the build:

```bash
npm run preview
```

---

## ☁️ Firebase Deployment

Deploy Firebase Hosting:

```bash
firebase deploy --only hosting
```

Deploy Cloud Functions:

```bash
firebase deploy --only functions
```

Deploy everything:

```bash
firebase deploy
```

---

## 🔧 Configuration Notes

### AI Providers

Dcalls automatically switches between configured AI providers based on availability.

Recommended setup:

* DeepSeek configured
* OpenRouter configured
* Gemini configured

This provides the highest reliability.

### Firebase Spark Plan

The project currently supports development and testing on Firebase's free Spark plan.

For larger deployments, consider:

* Optimizing Firestore reads and writes
* Reducing listener churn
* Monitoring WebRTC signaling traffic
* Reviewing AI usage costs

---

## 🧪 Development Status

Dcalls is actively under development.

Current focus areas:

* Messaging stability improvements
* Damai AI enhancements
* Voice and video call reliability
* Performance optimization
* Firebase optimization
* User experience improvements

---

## 📋 Roadmap

### Upcoming Features

* Enhanced group messaging
* Improved call quality
* Screen sharing
* AI-powered meeting assistance
* Advanced file sharing
* Offline support
* Desktop application enhancements

---

## 🤝 Contributing

Contributions, suggestions, and bug reports are welcome.

To contribute:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Submit a pull request

---

## 📄 License

This project is licensed under the MIT License unless stated otherwise.

---

## ❤️ Dcalls

Building smarter communication through messaging, calling, collaboration, and artificial intelligence.
