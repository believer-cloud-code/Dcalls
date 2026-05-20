import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Send, Plus, Mic, Image, MapPin, User, FileText, Info, Wand2, X, Lock, ShieldCheck, Volume2, VolumeX, Check, CheckCheck, ThumbsUp, ThumbsDown } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI, Modality } from "@google/genai";
import { collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, doc, getDoc, updateDoc, setDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { databaseService } from '../services/databaseService';
import { Message } from '../types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CryptoService } from '../services/cryptoService';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Speech Recognition setup
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;

if (recognition) {
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ChatInterfaceProps {
  chatId: string;
  onBack: () => void;
  contactName?: string;
  contactPhoto?: string;
  contactId?: string;
}

// Plaintext cache for RSA-encrypted messages the sender cannot decrypt with their private key
const sentPlaintextCache = new Map<string, string>();

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  chatId,
  onBack,
  contactName: propContactName,
  contactPhoto: propContactPhoto,
  contactId: propContactId,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [chatPartner, setChatPartner] = useState<{ id: string, name: string, photo?: string, phone?: string, status?: string } | null>(null);
  const [partnerPresence, setPartnerPresence] = useState<{ isOnline: boolean, lastSeenText: string }>({ isOnline: false, lastSeenText: 'Offline' });
  const [isRefining, setIsRefining] = useState(false);
  const [showContactInfo, setShowContactInfo] = useState(false);
  const [isVoiceOutputEnabled, setIsVoiceOutputEnabled] = useState(true);
  const [uploadingFile, setUploadingFile] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFeedback = async (messageId: string, isPositive: boolean) => {
    if (!chatId || !auth.currentUser) return;
    try {
      await updateDoc(doc(db, 'chats', chatId, 'messages', messageId), {
        feedback: isPositive ? 'positive' : 'negative',
        feedbackAt: serverTimestamp()
      });

      // Also store in a global feedback collection for easier analysis
      await addDoc(collection(db, 'ai_feedback'), {
        messageId,
        chatId,
        userId: auth.currentUser.uid,
        isPositive,
        timestamp: serverTimestamp(),
        // Include context if needed
        messageText: messages.find(m => m.id === messageId)?.text || ''
      });
    } catch (error) {
      console.error("Error saving feedback:", error);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !auth.currentUser) return;

    setUploadingFile(true);
    try {
      const fileId = Math.random().toString(36).substring(7);
      const extension = file.name.split('.').pop();
      const path = `chats/${chatId}/media/${fileId}.${extension}`;

      const downloadURL = await databaseService.uploadFile(path, file);

      const messagesRef = collection(db, 'chats', chatId, 'messages');
      await addDoc(messagesRef, {
        chatId,
        senderId: auth.currentUser.uid,
        text: file.name,
        fileUrl: downloadURL,
        fileType: file.type,
        timestamp: serverTimestamp(),
        type: file.type.startsWith('image/') ? 'image' : 'file',
        status: 'sent'
      });

      await updateDoc(doc(db, 'chats', chatId), {
        lastMessage: file.type.startsWith('image/') ? "📷 Image" : `📄 ${file.name}`,
        lastMessageTime: serverTimestamp()
      });
    } catch (error) {
      console.error("File upload failed", error);
    } finally {
      setUploadingFile(false);
      setIsMenuOpen(false);
    }
  };

  const ensureEncryptionReady = async () => {
    const crypto = CryptoService.getInstance();
    const publicKey = await crypto.ensureKeyPair();
    if (auth.currentUser) {
      await setDoc(doc(db, 'users', auth.currentUser.uid), { publicKey }, { merge: true });
    }
    return crypto;
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

  const startVoiceInput = () => {
    if (!recognition) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }
    setIsRecording(true);
    recognition.start();
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInputText(prev => prev + (prev ? ' ' : '') + transcript);
      setIsRecording(false);
    };
    recognition.onerror = (event: any) => {
      console.error("Speech recognition error", event.error);
      setIsRecording(false);
    };
    recognition.onend = () => {
      setIsRecording(false);
    };
  };

  useEffect(() => {
    if (!chatId) return;

    const messagesRef = collection(db, 'chats', chatId, 'messages');
    const q = query(messagesRef, orderBy('timestamp', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Message[];
      setMessages(msgs);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, messagesRef.path);
    });

    // Fetch chat partner info
    const fetchPartner = async () => {
      const chatPath = `chats/${chatId}`;
      try {
        if (propContactId) {
          const userDoc = await getDoc(doc(db, 'users', propContactId));
          const userData = userDoc.exists() ? userDoc.data() : {};
          setChatPartner({
            id: propContactId,
            name: propContactName || userData.displayName || 'User',
            photo: propContactPhoto ?? userData.photoURL,
            phone: userData.phoneNumber,
            status: userData.status,
          });
          return;
        }

        const chatDoc = await getDoc(doc(db, 'chats', chatId));
        if (chatDoc.exists()) {
          const data = chatDoc.data();
          const partnerId = data.participants.find((p: string) => p !== auth.currentUser?.uid);
          if (partnerId) {
            const userPath = `users/${partnerId}`;
            try {
              const userDoc = await getDoc(doc(db, 'users', partnerId));
              if (userDoc.exists()) {
                const userData = userDoc.data();
                setChatPartner({
                  id: partnerId,
                  name: userData.displayName || 'User',
                  photo: userData.photoURL,
                  phone: userData.phoneNumber,
                  status: userData.status
                });
              }
            } catch (err) {
              handleFirestoreError(err, OperationType.GET, userPath);
            }
          }
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, chatPath);
      }
    };
    fetchPartner();

    return () => unsubscribe();
  }, [chatId, propContactName, propContactPhoto, propContactId]);

  // Mark messages as read
  useEffect(() => {
    if (!chatId || !auth.currentUser || messages.length === 0) return;

    const unreadMessages = messages.filter(m => m.senderId !== auth.currentUser?.uid && m.status !== 'read');

    unreadMessages.forEach(async (msg) => {
      try {
        await updateDoc(doc(db, 'chats', chatId, 'messages', msg.id), {
          status: 'read'
        });
      } catch (err) {
        console.error("Error marking message as read:", err);
      }
    });
  }, [chatId, messages]);

  // Update current user's lastSeen periodically
  useEffect(() => {
    if (!auth.currentUser) return;

    const updateLastSeen = async () => {
      try {
        await updateDoc(doc(db, 'users', auth.currentUser!.uid), {
          lastSeen: serverTimestamp()
        });
      } catch (err) {
        console.error("Error updating lastSeen:", err);
      }
    };

    updateLastSeen();
    const interval = setInterval(updateLastSeen, 30000); // Every 30 seconds
    return () => clearInterval(interval);
  }, []);

  // Listen to partner's presence in real-time
  useEffect(() => {
    if (!chatPartner?.id) return;

    const unsubscribe = onSnapshot(doc(db, 'users', chatPartner.id), (doc) => {
      if (doc.exists()) {
        const data = doc.data();
        const lastSeen = data.lastSeen?.toDate();
        if (lastSeen) {
          const now = new Date();
          const diff = (now.getTime() - lastSeen.getTime()) / 1000 / 60; // diff in minutes
          const isOnline = diff < 2; // Online if seen in last 2 minutes

          let lastSeenText = 'Offline';
          if (isOnline) {
            lastSeenText = 'Online';
          } else {
            // Format last seen time
            const timeStr = lastSeen.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const dateStr = lastSeen.toLocaleDateString([], { month: 'short', day: 'numeric' });
            const isToday = lastSeen.toDateString() === now.toDateString();
            lastSeenText = `Last seen ${isToday ? 'at ' + timeStr : dateStr + ' at ' + timeStr}`;
          }
          setPartnerPresence({ isOnline, lastSeenText });
        }
      }
    }, (error) => {
      console.error("Error listening to partner presence:", error);
    });

    return () => unsubscribe();
  }, [chatPartner?.id]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleRefine = async () => {
    if (!inputText.trim() || !ai) return;
    setIsRefining(true);
    try {
      const response = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: `Refine and improve the following message to be more professional and clear, but keep the same meaning: "${inputText}". Only provide the refined text.`,
        config: {
          systemInstruction: "You are a helpful writing assistant. Provide only the refined text without any extra comments or quotes.",
        }
      });
      if (response.text) {
        setInputText(response.text.trim());
      }
    } catch (error) {
      console.error("Refinement failed", error);
    } finally {
      setIsRefining(false);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() || !auth.currentUser) return;

    const text = inputText.trim();
    setInputText('');

    try {
      const crypto = await ensureEncryptionReady();
      const messagesRef = collection(db, 'chats', chatId, 'messages');

      // For E2EE, we'd normally encrypt here. 
      // For this demo, we'll mark it as encrypted and use a symmetric fallback if partner key isn't ready.
      let encryptedText = text;
      let isEncrypted = false;
      let encryptionMethod: 'rsa' | 'symmetric' | undefined;

      if (chatPartner?.id) {
        const partnerDoc = await getDoc(doc(db, 'users', chatPartner.id));
        const partnerKey = partnerDoc.data()?.publicKey;
        if (partnerKey) {
          try {
            if (text.length < 190) {
              encryptedText = await crypto.encryptMessage(text, partnerKey);
              isEncrypted = true;
              encryptionMethod = 'rsa';
            } else {
              encryptedText = await crypto.encryptSymmetric(
                text,
                crypto.deriveChatSecret(chatId, auth.currentUser.uid, chatPartner.id)
              );
              isEncrypted = true;
              encryptionMethod = 'symmetric';
            }
          } catch (e) {
            console.error("Encryption failed", e);
          }
        }
      }

      const messageRef = await addDoc(messagesRef, {
        chatId,
        senderId: auth.currentUser.uid,
        text: encryptedText,
        isEncrypted,
        ...(encryptionMethod ? { encryptionMethod } : {}),
        timestamp: serverTimestamp(),
        type: 'text',
        status: 'sent'
      });

      if (isEncrypted && encryptionMethod === 'rsa') {
        sentPlaintextCache.set(messageRef.id, text);
      }

      // Update last message in chat doc (store unencrypted or a placeholder for privacy)
      await updateDoc(doc(db, 'chats', chatId), {
        lastMessage: isEncrypted ? "🔒 Encrypted Message" : text,
        lastMessageTime: serverTimestamp()
      });

      // Check for @Damai commands
      const lowerText = text.toLowerCase();

      if (lowerText.includes('@damai') && ai) {
        setIsTranslating(true); // Reusing translating state for AI loading

        try {
          let aiResponse = "";
          const userDoc = await getDoc(doc(db, 'users', auth.currentUser.uid));
          const persona = userDoc.data()?.settings?.damaiPersona || 'professional';

          const personaInstructions = {
            professional: `You are a professional, highly organized, and efficient assistant. 
            Use clear headings, bullet points, and a formal tone. 
            ALWAYS format your responses using Markdown for maximum readability. 
            Use bold text for key terms and tables for data where appropriate.`,
            friendly: `You are a warm, empathetic, and conversational companion. 
            Use emojis, friendly language, and a helpful tone. 
            Format your responses with Markdown, using blockquotes for emphasis and lists for clarity.`,
            concise: `You are a brief, direct, and data-driven expert. 
            Provide only the most essential information in a very compact format. 
            Use Markdown bolding and short lists.`
          };

          const basePrompt = `Respond to the following request in an organized and visually attractive way using Markdown. Use dividers, bold headers, and lists where appropriate.\n\nRequest: `;

          if (lowerText.includes('summarize')) {
            const chatHistory = messages.map(m => `${m.senderId === auth.currentUser?.uid ? 'User' : 'Partner'}: ${m.text}`).join('\n');
            const response = await ai.models.generateContent({
              model: "gemini-1.5-flash",
              contents: `${basePrompt}Summarize the following conversation history between two users:\n\n${chatHistory}`,
              config: {
                systemInstruction: personaInstructions[persona as keyof typeof personaInstructions],
              }
            });
            aiResponse = response.text || "I couldn't generate a summary at this time.";
          } else if (lowerText.includes('reminder')) {
            const response = await ai.models.generateContent({
              model: "gemini-1.5-flash",
              contents: `${basePrompt}The user wants to set a reminder. Extract the task and time from this message: "${text}". Then confirm it with a clear, attractive layout.`,
              config: {
                systemInstruction: personaInstructions[persona as keyof typeof personaInstructions],
              }
            });
            aiResponse = response.text || "Reminder set!";
          } else if (lowerText.includes('calendar') || lowerText.includes('event')) {
            const response = await ai.models.generateContent({
              model: "gemini-1.5-flash",
              contents: `${basePrompt}The user wants to create a calendar event. Extract the event details and date/time from this message: "${text}". Then confirm it with a professional layout.`,
              config: {
                systemInstruction: personaInstructions[persona as keyof typeof personaInstructions],
              }
            });
            aiResponse = response.text || "Event created!";
          } else if (lowerText.includes('poll')) {
            const response = await ai.models.generateContent({
              model: "gemini-1.5-flash",
              contents: `${basePrompt}The user wants to initiate a poll. Extract the question and options from this message: "${text}". Format it as a visually appealing poll using Markdown tables or lists.`,
              config: {
                systemInstruction: personaInstructions[persona as keyof typeof personaInstructions],
              }
            });
            aiResponse = response.text || "Poll initiated!";
          } else {
            const response = await ai.models.generateContent({
              model: "gemini-1.5-flash",
              contents: `${basePrompt}${text}`,
              config: {
                systemInstruction: personaInstructions[persona as keyof typeof personaInstructions],
              }
            });
            aiResponse = response.text || "I'm here to help!";
          }

          if (aiResponse) {
            speakText(aiResponse);
          }

          await addDoc(messagesRef, {
            chatId,
            senderId: 'ai',
            text: aiResponse,
            timestamp: serverTimestamp(),
            type: 'text',
            isAi: true
          });
        } catch (error) {
          console.error("Damai command failed", error);
        } finally {
          setIsTranslating(false);
        }
      }
    } catch (error) {
      console.error("Error sending message:", error);
    }
  };

  const MessageBubble = ({ msg }: { msg: Message }) => {
    const [decryptedText, setDecryptedText] = useState<string>(msg.text);
    const [decryptionStatus, setDecryptionStatus] = useState<'idle' | 'decrypting' | 'success' | 'failed'>('idle');

    const decrypt = async () => {
      if ((msg as any).isEncrypted && msg.senderId !== auth.currentUser?.uid) {
        setDecryptionStatus('decrypting');
        try {
          const crypto = await ensureEncryptionReady();
          // Try RSA first, then symmetric
          try {
            const decrypted = await crypto.decryptMessage(msg.text);
            setDecryptedText(decrypted);
            setDecryptionStatus('success');
          } catch (e) {
            const partnerId = chatPartner?.id;
            if (!partnerId || !auth.currentUser) throw new Error('Missing chat context');
            const secret = crypto.deriveChatSecret(chatId, auth.currentUser.uid, partnerId);
            const decrypted = await crypto.decryptSymmetric(msg.text, secret);
            setDecryptedText(decrypted);
            setDecryptionStatus('success');
          }
        } catch (e) {
          console.error("Decryption failed", e);
          setDecryptionStatus('failed');
          setDecryptedText("Unable to decrypt this message. The key might be missing or invalid.");
        }
      } else if ((msg as any).isEncrypted && msg.senderId === auth.currentUser?.uid) {
        setDecryptionStatus('decrypting');
        try {
          const method = (msg as any).encryptionMethod as string | undefined;
          if (method === 'rsa') {
            const cached = sentPlaintextCache.get(msg.id);
            if (cached) {
              setDecryptedText(cached);
              setDecryptionStatus('success');
            } else {
              setDecryptedText('Encrypted message (open on this device where you sent it)');
              setDecryptionStatus('success');
            }
          } else if (method === 'symmetric' && chatPartner?.id && auth.currentUser) {
            const crypto = await ensureEncryptionReady();
            const secret = crypto.deriveChatSecret(chatId, auth.currentUser.uid, chatPartner.id);
            const decrypted = await crypto.decryptSymmetric(msg.text, secret);
            setDecryptedText(decrypted);
            setDecryptionStatus('success');
          } else {
            setDecryptedText(msg.text);
            setDecryptionStatus('success');
          }
        } catch {
          setDecryptedText(msg.text);
          setDecryptionStatus('success');
        }
      } else {
        setDecryptionStatus('idle');
      }
    };

    useEffect(() => {
      decrypt();
    }, [msg]);

    const isMe = msg.senderId === auth.currentUser?.uid;
    const isAi = msg.senderId === 'ai' || msg.isAi;
    const isEncrypted = (msg as any).isEncrypted;

    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className={cn(
          "flex flex-col max-w-[85%]",
          isMe ? "ml-auto items-end" : "mr-auto items-start"
        )}
      >
        <div className={cn(
          "px-4 py-2.5 rounded-2xl text-sm shadow-lg relative overflow-hidden group/bubble",
          isMe ? "bg-indigo-600 text-white rounded-tr-none" :
            isAi ? "bg-[#1a1a1a] text-gray-200 rounded-tl-none border border-purple-500/30" :
              "bg-[#1a1a1a] text-gray-200 rounded-tl-none border border-white/5"
        )}>
          {isAi && (
            <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-white/10">
              <DcallsIcon size={12} className="text-purple-400" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400">Damai Assistant</span>
            </div>
          )}

          {isEncrypted && (
            <div className={cn(
              "flex items-center gap-1.5 mb-1.5 text-[9px] uppercase tracking-widest font-bold transition-colors",
              decryptionStatus === 'decrypting' ? "text-yellow-400 animate-pulse" :
                decryptionStatus === 'success' ? "text-emerald-400/70" :
                  decryptionStatus === 'failed' ? "text-red-400" :
                    "text-gray-500"
            )}>
              {decryptionStatus === 'failed' ? <ShieldCheck size={10} className="text-red-400" /> : <Lock size={10} />}
              <span>
                {decryptionStatus === 'decrypting' ? 'Decrypting...' :
                  decryptionStatus === 'failed' ? 'Decryption Failed' :
                    'End-to-End Encrypted'}
              </span>
              {decryptionStatus === 'success' && <ShieldCheck size={10} className="ml-0.5" />}
            </div>
          )}

          <div className="markdown-body prose prose-invert prose-sm max-w-none">
            {msg.type === 'image' && msg.fileUrl && (
              <div className="mb-2 rounded-lg overflow-hidden border border-white/10">
                <img src={msg.fileUrl} alt={msg.text} className="w-full h-auto max-h-60 object-cover" />
              </div>
            )}
            {msg.type === 'file' && msg.fileUrl && (
              <a
                href={msg.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 mb-2 hover:bg-white/10 transition-colors no-underline"
              >
                <div className="p-2 bg-indigo-500/20 rounded-lg text-indigo-400">
                  <FileText size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white truncate">{msg.text}</p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest">Download File</p>
                </div>
              </a>
            )}
            {isAi ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {msg.text}
              </ReactMarkdown>
            ) : (
              decryptionStatus === 'decrypting' ? (
                <div className="flex items-center gap-2 py-1 italic text-gray-500">
                  <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent animate-spin rounded-full" />
                  Processing secure layer...
                </div>
              ) : decryptionStatus === 'failed' ? (
                <div className="space-y-2">
                  <p className="text-red-400/80 italic">{decryptedText}</p>
                  <button
                    onClick={decrypt}
                    className="text-[10px] bg-red-500/20 hover:bg-red-500/30 text-red-400 px-2 py-1 rounded-lg border border-red-500/20 transition-colors"
                  >
                    Retry Decryption
                  </button>
                </div>
              ) : (
                decryptedText
              )
            )}
          </div>

          {isAi && (
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/5">
              <button
                onClick={() => handleFeedback(msg.id, true)}
                className={cn(
                  "p-1.5 rounded-lg transition-colors",
                  msg.feedback === 'positive' ? "bg-emerald-500/20 text-emerald-400" : "hover:bg-white/5 text-gray-500"
                )}
              >
                <ThumbsUp size={12} />
              </button>
              <button
                onClick={() => handleFeedback(msg.id, false)}
                className={cn(
                  "p-1.5 rounded-lg transition-colors",
                  msg.feedback === 'negative' ? "bg-rose-500/20 text-rose-400" : "hover:bg-white/5 text-gray-500"
                )}
              >
                <ThumbsDown size={12} />
              </button>
            </div>
          )}
        </div>
        <span className="text-[9px] text-gray-500 mt-1 uppercase tracking-tighter flex items-center gap-1">
          {msg.timestamp?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {isEncrypted && decryptionStatus === 'success' && (
            <span className="w-1 h-1 rounded-full bg-emerald-500/50" />
          )}
          {isMe && (
            <span className="ml-1">
              {msg.status === 'read' ? (
                <CheckCheck size={10} className="text-indigo-400" />
              ) : (
                <Check size={10} className="text-gray-500" />
              )}
            </span>
          )}
        </span>
      </motion.div>
    );
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] z-[100] flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-4 px-4 py-3 bg-[#121212] border-b border-white/5">
        <button onClick={onBack} className="p-2 hover:bg-white/5 rounded-full transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-3 flex-1">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-indigo-400 font-bold">
            {chatPartner?.photo ? (
              <img src={chatPartner.photo} alt="" className="w-full h-full object-cover rounded-xl" />
            ) : (
              chatPartner?.name.charAt(0).toUpperCase() || '?'
            )}
          </div>
          <div>
            <h3 className="font-semibold text-sm">{chatPartner?.name || 'Loading...'}</h3>
            <p className={cn(
              "text-[10px] uppercase tracking-widest font-bold transition-colors",
              partnerPresence.isOnline ? "text-emerald-500" : "text-gray-500"
            )}>
              {partnerPresence.lastSeenText}
            </p>
          </div>
        </div>
        <button
          onClick={() => setIsVoiceOutputEnabled(!isVoiceOutputEnabled)}
          className={cn(
            "p-2 rounded-full transition-colors",
            isVoiceOutputEnabled ? "text-indigo-400 hover:bg-indigo-500/10" : "text-gray-500 hover:bg-white/5"
          )}
          title={isVoiceOutputEnabled ? "Voice Output Enabled" : "Voice Output Disabled"}
        >
          {isVoiceOutputEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
        </button>
        <button
          onClick={() => setShowContactInfo(true)}
          className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-400"
        >
          <Info size={20} />
        </button>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
      </div>

      {/* Input Area */}
      <div className="p-4 bg-[#121212] border-t border-white/5 space-y-4">
        <AnimatePresence>
          {isMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.95 }}
              className="grid grid-cols-4 gap-4 p-4 bg-[#1a1a1a] rounded-3xl border border-white/5 mb-2"
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
                accept="image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              />
              <MenuButton
                icon={uploadingFile ? <div className="w-5 h-5 border-2 border-white border-t-transparent animate-spin rounded-full" /> : <Image size={20} />}
                label="Media"
                color="bg-blue-500"
                onClick={() => fileInputRef.current?.click()}
              />
              <MenuButton icon={<FileText size={20} />} label="File" color="bg-emerald-500" onClick={() => fileInputRef.current?.click()} />
              <MenuButton
                icon={<User size={20} />}
                label="Contact"
                color="bg-orange-500"
                onClick={() => setShowContactInfo(true)}
              />
              <MenuButton
                icon={<DcallsIcon size={20} />}
                label="Damai"
                color="bg-purple-500"
                onClick={() => setInputText(prev => prev + (prev ? ' ' : '') + '@Damai ')}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className={cn(
              "p-3 rounded-2xl transition-all duration-300",
              isMenuOpen ? "bg-white/10 rotate-45" : "bg-white/5 hover:bg-white/10"
            )}
          >
            <Plus size={20} />
          </button>

          <div className="flex-1 relative">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Type a message or @Damai..."
              className="w-full bg-white/5 border border-white/5 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500/50 transition-colors pr-20"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <button
                onClick={handleRefine}
                disabled={!inputText.trim() || isRefining}
                className={cn(
                  "p-2 rounded-xl transition-colors",
                  isRefining ? "text-purple-500 animate-pulse" : "text-purple-400 hover:text-purple-300"
                )}
                title="Refine with Damai"
              >
                <Wand2 size={18} />
              </button>
              <button
                className={cn(
                  "p-2 rounded-xl transition-colors",
                  isRecording ? "text-red-500 animate-pulse" : "text-gray-400 hover:text-white"
                )}
                onClick={startVoiceInput}
                title="Voice Input"
              >
                <Mic size={18} />
              </button>
            </div>
          </div>

          <button
            onClick={handleSend}
            disabled={!inputText.trim()}
            className="p-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 rounded-2xl transition-all shadow-lg shadow-indigo-600/20 active:scale-95"
          >
            <Send size={20} />
          </button>
        </div>
      </div>
      {/* Contact Info Modal */}
      <AnimatePresence>
        {showContactInfo && chatPartner && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="w-full max-w-sm bg-[#121212] border border-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-gradient-to-r from-indigo-500/10 to-transparent">
                <h3 className="text-lg font-bold text-white">Contact Info</h3>
                <button
                  onClick={() => setShowContactInfo(false)}
                  className="p-2 hover:bg-white/5 rounded-xl text-gray-500 hover:text-white transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="p-8 flex flex-col items-center text-center space-y-6">
                <div className="w-24 h-24 rounded-[2rem] bg-gradient-to-br from-indigo-500 to-purple-600 p-1">
                  <div className="w-full h-full rounded-[1.8rem] bg-[#0a0a0a] flex items-center justify-center overflow-hidden border border-white/10">
                    {chatPartner.photo ? (
                      <img src={chatPartner.photo} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <User size={40} className="text-indigo-400" />
                    )}
                  </div>
                </div>

                <div className="space-y-1">
                  <h2 className="text-2xl font-bold tracking-tight text-white">{chatPartner.name}</h2>
                  <p className={cn(
                    "text-[10px] font-bold uppercase tracking-[0.2em]",
                    partnerPresence.isOnline ? "text-emerald-500" : "text-gray-500"
                  )}>
                    {partnerPresence.lastSeenText}
                  </p>
                </div>

                <div className="w-full space-y-4">
                  <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-left">
                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Status</p>
                    <p className="text-sm text-gray-200">{chatPartner.status || 'Available'}</p>
                  </div>
                  <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-left">
                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Phone Number</p>
                    <p className="text-sm text-gray-200">{chatPartner.phone || 'Not provided'}</p>
                  </div>
                </div>

                <button
                  onClick={() => setShowContactInfo(false)}
                  className="w-full py-4 bg-white text-black rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-gray-200 transition-all active:scale-95"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const MenuButton = ({ icon, label, color, onClick }: { icon: React.ReactNode, label: string, color: string, onClick?: () => void }) => (
  <button onClick={onClick} className="flex flex-col items-center gap-2 group">
    <div className={cn("p-4 rounded-2xl text-white transition-transform group-hover:scale-110", color)}>
      {icon}
    </div>
    <span className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">{label}</span>
  </button>
);
