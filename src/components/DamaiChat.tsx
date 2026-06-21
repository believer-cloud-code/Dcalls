import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, User, Bot, Search, Trash2, MessageSquare, History, ThumbsUp, ThumbsDown, Globe, Mic, MicOff, X, Settings, Languages, Plus, Volume2, VolumeX, List, AlertTriangle, Paperclip, Image, File, Brain, Loader2 } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import { GoogleGenAI, Modality, ThinkingLevel } from "@google/genai";
import { FeedbackModal } from './FeedbackModal';
import { collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, getDocs, limit, where, writeBatch, doc, updateDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: any;
  sources?: { title: string; uri: string }[];
  files?: { name: string; type: string; data?: string }[];
  isThinking?: boolean;   // local placeholder only (local-ai-*)
  thinkingMode?: boolean; // persisted: reply was generated in thinking mode
}

interface ChatThread {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: any;
}

export const DamaiChat: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [userSettings, setUserSettings] = useState<any>(null);
  const [chatToDelete, setChatToDelete] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<{ name: string, type: string, data: string }[]>([]);
  const [isThinkingMode, setIsThinkingMode] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackMessageId, setFeedbackMessageId] = useState<string | null>(null);
  const [initialFeedbackRating, setInitialFeedbackRating] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const lastSuggestionMessageRef = useRef<string | null>(null);

  const normalizeTimestamp = (ts: any) => {
    if (!ts) return new Date();
    if (typeof ts.toDate === 'function') return ts.toDate();
    if (typeof ts === 'number') return new Date(ts);
    if (ts instanceof Date) return ts;
    try { return new Date(ts); } catch { return new Date(); }
  };

  const LANGUAGES = [
    'English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese', 'Korean', 'Portuguese', 'Russian', 'Italian'
  ];

  // Fetch User Settings
  useEffect(() => {
    if (!auth.currentUser) return;
    const unsubscribe = onSnapshot(doc(db, 'users', auth.currentUser.uid), (doc) => {
      if (doc.exists()) {
        setUserSettings(doc.data().settings || {});
      }
    });
    return () => unsubscribe();
  }, []);

  const translationPrefs = {
    inputLang: userSettings?.damaiInputLang || 'English',
    outputLang: userSettings?.damaiOutputLang || 'English'
  };

  const isVoiceOutputEnabled = userSettings?.damaiVoiceOutput ?? false;

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newFiles: { name: string, type: string, data: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1]);
        };
        reader.readAsDataURL(file);
      });
      newFiles.push({ name: file.name, type: file.type, data: base64 });
    }
    setAttachedFiles(prev => [...prev, ...newFiles]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const speakText = async (text: string) => {
    if (!isVoiceOutputEnabled || !ai) return;
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Aoede' },
            },
          },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`);
        audio.play();
      }
    } catch (error) {
      console.error("TTS failed", error);
    }
  };

  // Fetch Chat Threads
  useEffect(() => {
    if (!auth.currentUser) return;

    const q = query(
      collection(db, 'users', auth.currentUser.uid, 'damai_chats'),
      orderBy('timestamp', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const threads = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as ChatThread));
      setChatThreads(threads);

      // If no active chat, select the most recent one
      if (!activeChatId && threads.length > 0) {
        setActiveChatId(threads[0].id);
      }
    });

    return () => unsubscribe();
  }, [activeChatId]);

  // Fetch Messages for Active Chat (safe subscription + suggestion trigger)
  useEffect(() => {
    if (!auth.currentUser || !activeChatId) {
      setMessages([]);
      return;
    }

    const messagesRef = collection(db, 'users', auth.currentUser.uid, 'damai_chats', activeChatId, 'messages');
    const q = query(messagesRef, orderBy('timestamp', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const serverMsgs = snapshot.docs.map(d => {
        const data = d.data();
        return ({ id: d.id, ...data, timestamp: normalizeTimestamp(data.timestamp) }) as Message;
      });

      setMessages(prev => {
        const placeholders = (prev || []).filter(
          m => typeof m.id === 'string' && m.id.startsWith('local-ai-') && m.isThinking
        );
        const merged = [...serverMsgs, ...placeholders];

        if (prev && prev.length === merged.length) {
          const unchanged = merged.every((m, i) => {
            const p = prev[i];
            if (!p || p.id !== m.id) return false;
            return (
              p.text === m.text &&
              p.sender === m.sender &&
              p.isThinking === m.isThinking &&
              JSON.stringify(p.sources ?? []) === JSON.stringify(m.sources ?? [])
            );
          });
          if (unchanged) return prev;
        }

        return merged;
      });

      // If a new user message arrived, trigger suggestions once
      const lastMsg = serverMsgs.length > 0 ? serverMsgs[serverMsgs.length - 1] : null;
      if (lastMsg && lastMsg.sender === 'user' && lastMsg.id !== lastSuggestionMessageRef.current) {
        lastSuggestionMessageRef.current = lastMsg.id;
        void (async () => {
          try {
            // pass the last server messages for context
            await generateSuggestions(serverMsgs.slice(-6));
          } catch (e) {
            console.error('Suggestion generation failed:', e);
          }
        })();
      }
    }, (error) => {
      console.error('Damai messages listener error:', error);
    });

    return () => unsubscribe();
  }, [activeChatId]);

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInput(prev => prev + (prev ? ' ' : '') + transcript);
        setIsListening(false);
      };

      recognitionRef.current.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }
  }, []);

  const createNewChat = async () => {
    if (!auth.currentUser) return;

    const newChatRef = await addDoc(collection(db, 'users', auth.currentUser.uid, 'damai_chats'), {
      title: 'New Conversation',
      lastMessage: '',
      timestamp: serverTimestamp()
    });

    setActiveChatId(newChatRef.id);
    setShowSidebar(false);
  };

  useEffect(() => {
    if (scrollRef.current) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [messages]);

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch (e) {
        console.error("Failed to start listening:", e);
      }
    }
  };

  const generateSuggestions = async (recentMessages: Message[]) => {
    if (!ai || recentMessages.length === 0) return;
    try {
      const chatContext = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
      const response = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: `Based on this conversation history:\n${chatContext}\n\nSuggest 3 short, natural, and helpful quick replies the user might want to send next. Return only a JSON array of strings.`,
        config: {
          responseMimeType: "application/json",
        }
      });

      const raw = response.text?.trim();
      if (!raw) {
        setSuggestions([]);
        return;
      }

      // Try to parse JSON safely, fall back to line-splitting
      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        const match = raw.match(/\[.*\]/s);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
        }
      }

      if (Array.isArray(parsed)) {
        setSuggestions(parsed.slice(0, 3).map(s => (typeof s === 'string' ? s : String(s))));
      } else {
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        setSuggestions(lines.slice(0, 3));
      }
    } catch (error) {
      console.error("Error generating suggestions:", error);
      setSuggestions([]);
    }
  };

  const getContext = async () => {
    if (!auth.currentUser) return "";
    const q = query(
      collection(db, 'users', auth.currentUser.uid, 'ai_memory'),
      orderBy('timestamp', 'desc'),
      limit(10)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => {
      const data = doc.data();
      return `[Memory - ${data.topic}]: ${data.content}`;
    }).join("\n");
  };

  const handleSend = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || isLoading || !auth.currentUser || !ai) return;

    const userText = input.trim();
    const currentFiles = [...attachedFiles];
    setInput('');
    setAttachedFiles([]);
    setIsLoading(true);

    try {
      let chatId = activeChatId;

      // If no active chat, create one
      if (!chatId) {
        const newChatRef = await addDoc(collection(db, 'users', auth.currentUser.uid, 'damai_chats'), {
          title: userText.slice(0, 30) || currentFiles[0]?.name.slice(0, 30) || 'New Conversation',
          lastMessage: userText || `Sent ${currentFiles.length} files`,
          timestamp: serverTimestamp()
        });
        chatId = newChatRef.id;
        setActiveChatId(chatId);
      }

      // 1. Save user message
      await addDoc(collection(db, 'users', auth.currentUser.uid, 'damai_chats', chatId, 'messages'), {
        text: userText,
        sender: 'user',
        timestamp: serverTimestamp(),
        files: currentFiles.map(f => ({ name: f.name, type: f.type }))
      });

      // Update chat thread last message
      await updateDoc(doc(db, 'users', auth.currentUser.uid, 'damai_chats', chatId), {
        lastMessage: userText || `Sent ${currentFiles.length} files`,
        timestamp: serverTimestamp()
      });

      // 2. Get context from memory
      const memoryContext = await getContext();

      // Insert an optimistic local AI placeholder so the UI shows an immediate response
      const tempAiId = `local-ai-${Date.now()}`;
      setMessages(prev => [...prev, {
        id: tempAiId,
        text: 'Thinking...',
        sender: 'ai',
        timestamp: Date.now(),
        isThinking: true
      }]);

      // 3. Generate AI response (model may be slower in thinking mode)
      const modelName = isThinkingMode ? "gemini-1.5-pro" : "gemini-1.5-flash";

      const parts: any[] = [];
      if (userText) parts.push({ text: userText });
      currentFiles.forEach(file => {
        parts.push({
          inlineData: {
            mimeType: file.type,
            data: file.data
          }
        });
      });

      let serverAiSaved = false;
      let aiText = '';
      let sources: any[] = [];
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [{ parts }],
          config: {
            systemInstruction: `You are Damai, a highly personalized AI assistant with long-term memory. 
          You learn from user feedback and web searches.
          
          User Memory Context:
          ${memoryContext}
          
          Translation Preferences:
          - User Input Language: ${translationPrefs.inputLang}
          - AI Output Language: ${translationPrefs.outputLang}
          
          Guidelines:
          - Be context-aware. If the user mentions something you should remember, acknowledge it.
          - Use Google Search for facts, current events, or when you need more info.
          - If the user corrects you, update your internal understanding.
          - Maintain a helpful, friendly, and professional tone.
          - IMPORTANT: Respond in ${translationPrefs.outputLang} as per the user's preference.`,
            tools: [{ googleSearch: {} }],
            thinkingConfig: isThinkingMode ? { thinkingLevel: ThinkingLevel.HIGH } : undefined
          }
        });

        aiText = response.text || "I'm sorry, I couldn't process that.";
        sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map(chunk => ({
          title: chunk.web?.title || "Source",
          uri: chunk.web?.uri || ""
        })) || [];

        // 4. Save AI response to Firestore (this will trigger the canonical onSnapshot listener)
        await addDoc(collection(db, 'users', auth.currentUser.uid, 'damai_chats', chatId, 'messages'), {
          text: aiText,
          sender: 'ai',
          timestamp: serverTimestamp(),
          sources,
          thinkingMode: isThinkingMode
        });

        // Speak AI response
        speakText(aiText);

        // Update chat thread last message
        await updateDoc(doc(db, 'users', auth.currentUser.uid, 'damai_chats', chatId), {
          lastMessage: aiText.slice(0, 50) + (aiText.length > 50 ? '...' : ''),
          timestamp: serverTimestamp()
        });

        serverAiSaved = true;
      } catch (error) {
        console.error("Damai AI Error:", error);
        // Mark the optimistic message as failed so the user can retry
        setMessages(prev => prev.map(m => m.id === tempAiId ? { ...m, text: "[Damai failed to respond]", isThinking: false } : m));
      } finally {
        // Remove the optimistic placeholder if the server saved a canonical message (the snapshot listener will add the server message)
        if (serverAiSaved) {
          setMessages(prev => prev.filter(m => m.id !== tempAiId));
        }
      }

      // Update title if it's still "New Conversation" or generic
      const currentThread = chatThreads.find(t => t.id === chatId);
      if (currentThread && (currentThread.title === 'New Conversation' || currentThread.title.startsWith(userText.slice(0, 10))) && ai) {
        const titleResponse = await ai.models.generateContent({
          model: "gemini-1.5-flash",
          contents: `Generate a very short (max 4 words) title for a chat that starts with: "${userText}"`,
        });
        if (titleResponse.text) {
          await updateDoc(doc(db, 'users', auth.currentUser.uid, 'damai_chats', chatId), {
            title: titleResponse.text.trim().replace(/"/g, '')
          });
        }
      }

      // 5. Intelligent Memory Update
      const storeMemory = async (topic: string, content: string, source: string) => {
        if (!auth.currentUser) return;
        await addDoc(collection(db, 'users', auth.currentUser.uid, 'ai_memory'), {
          topic,
          content,
          source,
          timestamp: serverTimestamp()
        });
      };

      const shouldStore = userText.toLowerCase().includes('remember') ||
        userText.toLowerCase().includes('don\'t forget') ||
        userText.toLowerCase().includes('keep in mind');

      if (shouldStore) {
        await storeMemory(
          userText.slice(0, 50),
          aiText.slice(0, 500),
          sources[0]?.uri || 'chat_interaction'
        );
      }

    } catch (error) {
      console.error("Damai AI Error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFeedback = async (messageId: string, rating: number, comment?: string) => {
    if (!auth.currentUser) return;

    await addDoc(collection(db, 'users', auth.currentUser.uid, 'feedback'), {
      messageId,
      rating,
      comment: comment || '',
      timestamp: serverTimestamp()
    });

    if (rating > 0) {
      const msg = messages.find(m => m.id === messageId);
      if (msg) {
        await addDoc(collection(db, 'users', auth.currentUser.uid, 'ai_memory'), {
          topic: "User Liked Response",
          content: msg.text.slice(0, 500) + (comment ? ` (Comment: ${comment})` : ''),
          source: 'positive_feedback',
          timestamp: serverTimestamp()
        });
      }
    }
  };

  const deleteChat = async (chatId: string) => {
    if (!auth.currentUser) return;

    const batch = writeBatch(db);
    const q = query(collection(db, 'users', auth.currentUser.uid, 'damai_chats', chatId, 'messages'));
    const snapshot = await getDocs(q);
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(doc(db, 'users', auth.currentUser.uid, 'damai_chats', chatId));
    await batch.commit();

    if (activeChatId === chatId) {
      setActiveChatId(null);
    }
    setChatToDelete(null);
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] z-40 flex overflow-hidden">
      {/* Sidebar */}
      <AnimatePresence>
        {/* Hover region to reveal sidebar on desktop */}
        <div
          className="hidden lg:block absolute left-0 top-0 h-full w-4 z-50"
          onMouseEnter={() => setShowSidebar(true)}
          onMouseLeave={() => setShowSidebar(false)}
          aria-hidden
        />

        {(showSidebar || window.innerWidth > 1024) && (
          <motion.aside
            initial={{ x: -300 }}
            animate={{ x: 0 }}
            exit={{ x: -300 }}
            className={cn(
              "w-72 bg-[#121212] border-r border-white/5 flex flex-col z-50 absolute lg:relative h-full",
              !showSidebar && "hidden lg:flex"
            )}
          >
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <DcallsIcon size={20} className="text-purple-400" />
                <span className="font-bold text-white">Damai Chats</span>
              </div>
              <button onClick={() => setShowSidebar(false)} className="lg:hidden text-gray-500">
                <X size={20} />
              </button>
            </div>

            <div className="p-4">
              <button
                onClick={createNewChat}
                className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-white text-xs font-bold uppercase tracking-widest flex items-center justify-center gap-2 transition-all active:scale-95"
              >
                <Plus size={16} />
                New Chat
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 space-y-2 pb-20">
              {chatThreads.map(thread => (
                <div key={thread.id} className="group relative">
                  <button
                    onClick={() => {
                      setActiveChatId(thread.id);
                      setShowSidebar(false);
                    }}
                    className={cn(
                      "w-full p-4 rounded-2xl text-left transition-all relative",
                      activeChatId === thread.id ? "bg-purple-600/20 border border-purple-500/30" : "hover:bg-white/5 border border-transparent"
                    )}
                  >
                    <h4 className={cn(
                      "text-sm font-semibold truncate mb-1 pr-8",
                      activeChatId === thread.id ? "text-purple-400" : "text-gray-300"
                    )}>
                      {thread.title}
                    </h4>
                    <p className="text-[10px] text-gray-500 truncate">{thread.lastMessage || 'No messages yet'}</p>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setChatToDelete(thread.id);
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-2 opacity-0 group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-400 rounded-xl transition-all text-gray-600"
                    title="Delete Chat"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 bg-[#121212] border-b border-white/5">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="p-2 hover:bg-white/5 rounded-xl text-gray-500 hover:text-purple-400 transition-colors"
              title={showSidebar ? "Hide Dashboard" : "Show Dashboard"}
            >
              <List size={20} />
            </button>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-500/20">
              <DcallsIcon size={20} className="text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-tight text-white">
                {chatThreads.find(t => t.id === activeChatId)?.title || 'Damai Assistant'}
              </h2>
              <p className="text-[10px] text-emerald-500 font-bold uppercase tracking-widest">Context Aware Memory</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-500 hover:text-purple-400"
              title="Translation Settings"
            >
              <Settings size={20} />
            </button>
            <button
              onClick={() => activeChatId && setChatToDelete(activeChatId)}
              className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-500 hover:text-red-400"
              title="Delete Current Chat"
            >
              <Trash2 size={20} />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-500">
              <X size={20} />
            </button>
          </div>
        </header>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth relative w-full">
          {/* Settings Overlay */}
          <AnimatePresence>
            {showSettings && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="absolute top-4 right-4 w-64 bg-[#1a1a1a] border border-white/10 rounded-2xl shadow-2xl z-[60] p-4 space-y-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Languages size={16} className="text-purple-400" />
                    Translation
                  </h3>
                  <button onClick={() => setShowSettings(false)} className="text-gray-500 hover:text-white">
                    <X size={16} />
                  </button>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Input Language</label>
                    <select
                      value={translationPrefs.inputLang}
                      onChange={async (e) => {
                        if (!auth.currentUser) return;
                        await updateDoc(doc(db, 'users', auth.currentUser.uid), {
                          'settings.damaiInputLang': e.target.value
                        });
                      }}
                      className="w-full bg-black/40 border border-white/5 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500/50"
                    >
                      {LANGUAGES.map(lang => <option key={lang} value={lang}>{lang}</option>)}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Output Language</label>
                    <select
                      value={translationPrefs.outputLang}
                      onChange={async (e) => {
                        if (!auth.currentUser) return;
                        await updateDoc(doc(db, 'users', auth.currentUser.uid), {
                          'settings.damaiOutputLang': e.target.value
                        });
                      }}
                      className="w-full bg-black/40 border border-white/5 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500/50"
                    >
                      {LANGUAGES.map(lang => <option key={lang} value={lang}>{lang}</option>)}
                    </select>
                  </div>

                  <div className="pt-2 border-t border-white/5">
                    <button
                      onClick={async () => {
                        if (!auth.currentUser) return;
                        await updateDoc(doc(db, 'users', auth.currentUser.uid), {
                          'settings.damaiVoiceOutput': !isVoiceOutputEnabled
                        });
                      }}
                      className={cn(
                        "w-full flex items-center justify-between p-2 rounded-xl transition-all",
                        isVoiceOutputEnabled ? "bg-purple-600/20 text-purple-400" : "bg-white/5 text-gray-500"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {isVoiceOutputEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
                        <span className="text-xs font-bold">Voice Output</span>
                      </div>
                      <div className={cn(
                        "w-8 h-4 rounded-full relative transition-all",
                        isVoiceOutputEnabled ? "bg-purple-500" : "bg-gray-700"
                      )}>
                        <div className={cn(
                          "absolute top-1 w-2 h-2 rounded-full bg-white transition-all",
                          isVoiceOutputEnabled ? "right-1" : "left-1"
                        )} />
                      </div>
                    </button>
                  </div>
                </div>

                <p className="text-[9px] text-gray-600 leading-tight">
                  Damai will automatically translate your inputs and responses based on these preferences.
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-50">
              <Bot size={48} className="text-purple-500" />
              <div className="space-y-1">
                <h3 className="text-xl font-bold text-white">How can I help you today?</h3>
                <p className="text-sm text-gray-400 max-w-xs">I remember our past conversations to give you better, more personalized help.</p>
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "flex gap-4 max-w-3xl mx-auto w-full group",
                msg.sender === 'user' ? "flex-row-reverse" : "flex-row"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-1",
                msg.sender === 'user' ? "bg-indigo-500" : "bg-purple-600"
              )}>
                {msg.sender === 'user' ? <User size={16} className="text-white" /> : <Bot size={16} className="text-white" />}
              </div>
              <div className="space-y-3 flex-1">
                <div className={cn(
                  "p-4 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap overflow-visible word-break",
                  msg.sender === 'user' ? "bg-white/5 text-white ml-auto max-w-2xl" : "bg-transparent text-gray-200 max-w-2xl"
                )}>
                  {msg.thinkingMode && (
                    <div className="flex items-center gap-2 mb-2 text-[10px] font-bold text-purple-400 uppercase tracking-widest">
                      <Brain size={12} />
                      Deep Thinking Mode
                    </div>
                  )}
                  {msg.text}

                  {msg.files && msg.files.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {msg.files.map((file, i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-2 bg-white/5 rounded-xl border border-white/5 text-[10px]">
                          {file.type.startsWith('image/') ? <Image size={12} /> : <File size={12} />}
                          <span className="truncate max-w-[100px]">{file.name}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-white/5 space-y-2">
                      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest flex items-center gap-1">
                        <Globe size={10} /> Sources
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {msg.sources.map((s, i) => (
                          <a key={i} href={s.uri} target="_blank" rel="noreferrer" className="text-[10px] px-2 py-1 bg-white/5 rounded-md hover:bg-white/10 transition-colors text-indigo-400 truncate max-w-[150px]">
                            {s.title}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {msg.sender === 'ai' && (
                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleFeedback(msg.id, 1)}
                      className="p-1.5 hover:bg-white/5 rounded-md text-gray-500 hover:text-emerald-500 transition-colors"
                      title="Thumbs Up"
                    >
                      <ThumbsUp size={14} />
                    </button>
                    <button
                      onClick={() => handleFeedback(msg.id, -1)}
                      className="p-1.5 hover:bg-white/5 rounded-md text-gray-500 hover:text-red-500 transition-colors"
                      title="Thumbs Down"
                    >
                      <ThumbsDown size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setFeedbackMessageId(msg.id);
                        setInitialFeedbackRating(0);
                        setShowFeedbackModal(true);
                      }}
                      className="p-1.5 hover:bg-white/5 rounded-md text-gray-500 hover:text-purple-400 transition-colors"
                      title="Detailed Feedback"
                    >
                      <MessageSquare size={14} />
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
          {/* AI loading shown only via local-ai-* placeholder in messages list */}
        </div>

        {/* Input */}
        <div className="p-6 bg-gradient-to-t from-[#0a0a0a] to-transparent">
          {/* Attached Files */}
          <AnimatePresence>
            {attachedFiles.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="max-w-3xl mx-auto flex flex-wrap gap-2 mb-4"
              >
                {attachedFiles.map((file, i) => (
                  <div key={i} className="group relative flex items-center gap-2 px-3 py-2 bg-purple-600/10 border border-purple-500/20 rounded-xl text-xs text-purple-300">
                    {file.type.startsWith('image/') ? <Image size={14} /> : <File size={14} />}
                    <span className="truncate max-w-[150px]">{file.name}</span>
                    <button
                      onClick={() => removeFile(i)}
                      className="p-1 hover:bg-red-500/20 hover:text-red-400 rounded-lg transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Smart Replies */}
          <AnimatePresence>
            {suggestions.length > 0 && !isLoading && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="max-w-3xl mx-auto flex flex-wrap gap-2 mb-4"
              >
                {suggestions.map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setInput(suggestion);
                      setSuggestions([]);
                    }}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-xs text-indigo-300 transition-all active:scale-95"
                  >
                    {suggestion}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="max-w-3xl mx-auto flex items-end gap-3">
            <div className="flex flex-col gap-2">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                multiple
                className="hidden"
                accept="image/*,video/*,application/pdf,.doc,.docx,.txt"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-4 bg-white/5 text-gray-400 hover:text-white hover:bg-white/10 rounded-2xl transition-all active:scale-95"
                title="Upload Files"
              >
                <Paperclip size={20} />
              </button>
              <button
                onClick={() => setIsThinkingMode(!isThinkingMode)}
                className={cn(
                  "p-4 rounded-2xl transition-all active:scale-95",
                  isThinkingMode
                    ? "bg-purple-600/20 text-purple-400 border border-purple-500/30"
                    : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
                )}
                title="Thinking Mode"
              >
                <Brain size={20} />
              </button>
            </div>
            <div className="relative flex-1">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={isListening ? "Listening..." : "Message Damai..."}
                className={cn(
                  "w-full bg-[#1a1a1a] border border-white/10 rounded-2xl px-4 py-4 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-all resize-none min-h-[56px] max-h-32",
                  isListening && "border-red-500/50 placeholder:text-red-400"
                )}
                rows={1}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={toggleListening}
                className={cn(
                  "p-4 rounded-2xl transition-all active:scale-95 shadow-lg",
                  isListening
                    ? "bg-red-500 text-white animate-pulse shadow-red-500/20"
                    : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
                )}
                title="Voice Input"
              >
                {isListening ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="p-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:hover:bg-purple-600 rounded-2xl text-white transition-all active:scale-95 shadow-lg shadow-purple-600/20"
              >
                <Send size={20} />
              </button>
            </div>
          </div>
          <p className="text-center text-[10px] text-gray-600 mt-4 uppercase tracking-widest">
            Damai learns from your feedback and searches the web for accuracy.
          </p>
        </div>
        {/* Confirmation Modal */}
        {/* Modals */}
        <FeedbackModal
          isOpen={showFeedbackModal}
          onClose={() => setShowFeedbackModal(false)}
          onSubmit={async (rating, comment) => {
            if (feedbackMessageId) {
              await handleFeedback(feedbackMessageId, rating, comment);
            }
          }}
          initialRating={initialFeedbackRating}
        />

        <AnimatePresence>
          {chatToDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[500] flex items-center justify-center p-6"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="w-full max-w-sm bg-[#1a1a1a] border border-white/10 rounded-3xl p-6 space-y-6 shadow-2xl"
              >
                <div className="flex flex-col items-center text-center space-y-4">
                  <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center text-red-500">
                    <AlertTriangle size={32} />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold text-white">Delete Chat?</h3>
                    <p className="text-sm text-gray-400">This will permanently remove all messages in this conversation. This action cannot be undone.</p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setChatToDelete(null)}
                    className="flex-1 py-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white text-sm font-bold transition-all active:scale-95"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => deleteChat(chatToDelete)}
                    className="flex-1 py-3 bg-red-600 hover:bg-red-500 rounded-2xl text-white text-sm font-bold transition-all active:scale-95 shadow-lg shadow-red-600/20"
                  >
                    Delete
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
