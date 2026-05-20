import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Volume2, VolumeX, Trash2, Share2, Copy } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const LiveTranscription: React.FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [transcription, setTranscription] = useState<{ text: string, isAi: boolean }[]>([]);
  const [currentText, setCurrentText] = useState('');
  const [error, setError] = useState<string | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);

  const startListening = async () => {
    try {
      setError(null);
      const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

      if (!GEMINI_API_KEY) {
        throw new Error("Missing VITE_GEMINI_API_KEY");
      }

      const ai = new GoogleGenAI({
        apiKey: GEMINI_API_KEY,
      });
      
      const session = await ai.live.connect({
        model: "gemini-2.0-flash",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are a live transcription assistant. Transcribe the user's audio accurately. If you detect a question or a request for help, provide a helpful, attractive, and organized response using emojis and clear formatting. Keep the transcription fluid.",
        },
        callbacks: {
          onopen: () => {
            console.log("Live connection opened");
            setIsListening(true);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts) {
              const text = message.serverContent.modelTurn.parts.map(p => p.text).join('');
              if (text) {
                setTranscription(prev => [...prev, { text, isAi: true }]);
              }
            }
            
            if (message.serverContent?.interrupted) {
              console.log("Interrupted");
            }
          },
          onerror: (err) => {
            console.error("Live error:", err);
            setError("Connection error. Please try again.");
            stopListening();
          },
          onclose: () => {
            console.log("Live connection closed");
            setIsListening(false);
          }
        }
      });

      sessionRef.current = session;

      // Setup Audio Capture
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!isListening) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 to Int16 PCM
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
        session.sendRealtimeInput({
          media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
        });
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

    } catch (err: any) {
      console.error("Failed to start listening:", err);
      setError(err.message || "Could not access microphone.");
      setIsListening(false);
    }
  };

  const stopListening = () => {
    setIsListening(false);
    
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
  };

  const clearTranscription = () => {
    setTranscription([]);
  };

  const copyToClipboard = () => {
    const text = transcription.map(t => t.text).join('\n');
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] text-white p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-500",
            isListening ? "bg-indigo-600 shadow-lg shadow-indigo-600/20 animate-pulse" : "bg-white/5"
          )}>
            {isListening ? <Mic size={24} /> : <MicOff size={24} className="text-gray-500" />}
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight">Live Transcription</h2>
            <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">
              {isListening ? "Listening to audio feed..." : "Microphone is off"}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={clearTranscription}
            className="p-3 hover:bg-white/5 rounded-xl text-gray-400 transition-colors"
            title="Clear"
          >
            <Trash2 size={20} />
          </button>
          <button 
            onClick={copyToClipboard}
            className="p-3 hover:bg-white/5 rounded-xl text-gray-400 transition-colors"
            title="Copy"
          >
            <Copy size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 bg-white/5 rounded-[2.5rem] border border-white/5 p-6 overflow-y-auto relative group">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#0a0a0a]/50 pointer-events-none" />
        
        <div className="space-y-6 relative z-10">
          {transcription.length === 0 && !isListening && (
            <div className="flex flex-col items-center justify-center h-full py-20 text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                <DcallsIcon size={32} />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-gray-300">Start Transcribing</h3>
                <p className="text-xs text-gray-500 max-w-[200px]">Tap the button below to start real-time audio transcription.</p>
              </div>
            </div>
          )}
          
          {transcription.map((item, index) => (
            <motion.div 
              key={index}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "p-4 rounded-2xl text-sm leading-relaxed markdown-body",
                item.isAi ? "bg-indigo-500/10 border border-indigo-500/20 text-indigo-100" : "bg-white/5 text-gray-300"
              )}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {item.text}
              </ReactMarkdown>
            </motion.div>
          ))}
          
          {isListening && (
            <div className="flex items-center gap-2 text-indigo-400 text-xs font-bold animate-pulse">
              <div className="flex gap-1">
                <div className="w-1 h-1 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1 h-1 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '200ms' }} />
                <div className="w-1 h-1 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '400ms' }} />
              </div>
              Processing audio...
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-xs text-red-400 font-bold text-center">
          {error}
        </div>
      )}

      <button
        onClick={isListening ? stopListening : startListening}
        className={cn(
          "w-full py-5 rounded-[2rem] font-bold uppercase tracking-[0.2em] text-xs transition-all active:scale-95 shadow-2xl",
          isListening 
            ? "bg-red-500/10 border border-red-500/20 text-red-500 hover:bg-red-500/20" 
            : "bg-indigo-600 text-white hover:bg-indigo-500 shadow-indigo-600/20"
        )}
      >
        {isListening ? "Stop Transcription" : "Start Live Transcription"}
      </button>
    </div>
  );
};
