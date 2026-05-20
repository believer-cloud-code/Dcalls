import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const OPENROUTER_API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY;
const DEEPSEEK_API_KEY = import.meta.env.VITE_DEEPSEEK_API_KEY;

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const systemPrompt = "You are Damai, a friendly and efficient AI assistant integrated into Dcalls, a messaging app. You help users with translations, summaries, and general questions. Keep your responses concise and helpful. ALWAYS format your responses using Markdown for maximum readability.";

export const getDamaiResponse = async (prompt: string, context?: string) => {
  // Try DeepSeek first if API key is available
  if (DEEPSEEK_API_KEY) {
    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          "model": "deepseek-chat",
          "messages": [
            {
              "role": "system",
              "content": systemPrompt
            },
            {
              "role": "user",
              "content": `Context: ${context || 'No specific context provided.'}\nUser says: ${prompt}`
            }
          ],
          "temperature": 0.7,
          "max_tokens": 1000
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
      }
    } catch (error) {
      console.error("DeepSeek call failed, trying OpenRouter", error);
    }
  }

  // Try OpenRouter as fallback
  if (OPENROUTER_API_KEY) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": window.location.origin,
          "X-Title": "Dcalls",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          "model": "google/gemini-pro-1.5",
          "messages": [
            {
              "role": "system",
              "content": systemPrompt
            },
            {
              "role": "user",
              "content": `Context: ${context || 'No specific context provided.'}\nUser says: ${prompt}`
            }
          ]
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
      }
    } catch (error) {
      console.error("OpenRouter call failed, falling back to Gemini SDK", error);
    }
  }

  // Fallback to Gemini SDK
  if (!ai) {
    throw new Error('No AI provider available. Please configure at least one API key (DeepSeek, OpenRouter, or Gemini)');
  }

  const response = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: [
      {
        role: "user",
        parts: [{
          text: `You are Damai, a helpful AI assistant integrated into Dcalls, a messaging app. 
        Context: ${context || 'No specific context provided.'}
        User says: ${prompt}`
        }]
      }
    ],
    config: {
      systemInstruction: "You are Damai, a friendly and efficient AI assistant. You help users with translations, summaries, and general questions. Keep your responses concise and helpful. ALWAYS format your responses using Markdown for maximum readability."
    }
  });

  return response.text;
};

export const getFastSummary = async (text: string) => {
  const summaryPrompt = `Summarize the following conversation into a structured format with bullet points. 
              Highlight the main topics discussed and any action items agreed upon.
              
              Format:
              ### Main Topics
              - Topic 1
              - Topic 2
              
              ### Action Items
              - Action 1
              - Action 2
              
              Conversation: ${text}`;

  // Try DeepSeek first if API key is available
  if (DEEPSEEK_API_KEY) {
    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          "model": "deepseek-chat",
          "messages": [
            {
              "role": "system",
              "content": "You are an expert summarizer. Provide a structured summary with main topics and action items."
            },
            {
              "role": "user",
              "content": summaryPrompt
            }
          ],
          "temperature": 0.7,
          "max_tokens": 1500
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
      }
    } catch (error) {
      console.error("DeepSeek summary call failed, trying OpenRouter", error);
    }
  }

  // Try OpenRouter as fallback
  if (OPENROUTER_API_KEY) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": window.location.origin,
          "X-Title": "Dcalls",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          "model": "google/gemini-2.0-flash-001",
          "messages": [
            {
              "role": "system",
              "content": "You are an expert summarizer. Provide a structured summary with main topics and action items."
            },
            {
              "role": "user",
              "content": summaryPrompt
            }
          ]
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
      }
    } catch (error) {
      console.error("OpenRouter summary call failed, falling back to Gemini SDK", error);
    }
  }

  if (!ai) {
    return null;
  }

  const response = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: [
      {
        role: "user",
        parts: [{
          text: `Summarize the following conversation into a structured format with bullet points. 
        Highlight the main topics discussed and any action items agreed upon.
        
        Format:
        ### Main Topics
        - Topic 1
        - Topic 2
        
        ### Action Items
        - Action 1
        - Action 2
        
        Conversation: ${text}`
        }]
      }
    ]
  });

  return response.text;
};

export const transcribeAudio = async (base64Audio: string) => {
  if (!ai) {
    throw new Error('No AI provider available. Please configure at least one API key (DeepSeek, OpenRouter, or Gemini)');
  }

  const response = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: [
      {
        parts: [
          { inlineData: { mimeType: "audio/wav", data: base64Audio } },
          { text: "Transcribe this audio accurately." }
        ]
      }
    ]
  });

  return response.text;
};
