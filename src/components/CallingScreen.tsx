import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { PhoneOff, Mic, MicOff, Volume2, VolumeX, Languages, X, Maximize2, Circle, Square, ChevronDown, Globe, Video, VideoOff, Shield, Users, MessageCircle, Share, Smile, MoreHorizontal, Phone, Wind, Settings, ShieldCheck, ThumbsUp, ThumbsDown, MessageSquare } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot, doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { CryptoService } from '../services/cryptoService';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
];

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

import { databaseService } from '../services/databaseService';
import { WebRTCService } from '../services/webrtcService';
import { getFastSummary } from '../services/gemini';
import { translateUtterance, speechLangForCode } from '../services/translationService';
import { FeedbackModal } from './FeedbackModal';

interface CallingScreenProps {
  onEnd: () => void;
  type: 'voice' | 'video';
  contactName?: string;
  contactPhoto?: string;
  contactId?: string;
  incomingCallId?: string;
}

export const CallingScreen: React.FC<CallingScreenProps> = ({ onEnd, type, contactName = "Sarah Wilson", contactPhoto, contactId, incomingCallId }) => {
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(type === 'voice');
  const [isSpeaker, setIsSpeaker] = useState(true);
  const [isTranslationOn, setIsTranslationOn] = useState(false);
  const [isNoiseCancellationOn, setIsNoiseCancellationOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [virtualBackground, setVirtualBackground] = useState<'none' | 'blur' | 'image'>('none');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [callDuration, setCallDuration] = useState(0);
  const [callStatus, setCallStatus] = useState<'connecting' | 'connected' | 'ended'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>(new Array(20).fill(0));
  const [showChat, setShowChat] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [finalSummary, setFinalSummary] = useState('');
  const [memories, setMemories] = useState<any[]>([]);
  const [participants] = useState([
    { id: 'me', name: auth.currentUser?.displayName || 'You', photo: auth.currentUser?.photoURL },
    { id: 'remote', name: contactName, photo: contactPhoto }
  ]);

  const [sourceLang, setSourceLang] = useState(LANGUAGES[1]); // Default Spanish
  const [targetLang, setTargetLang] = useState(LANGUAGES[0]); // Default English
  const [isLangSelectorOpen, setIsLangSelectorOpen] = useState(false);

  // WebRTC States
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isRemoteVideoActive, setIsRemoteVideoActive] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const webrtc = WebRTCService.getInstance();
  const unsubscribersRef = useRef<Array<() => void>>([]);
  const callTranscriptRef = useRef<string[]>([]);
  const recognitionRef = useRef<any>(null);
  const isTranslationOnRef = useRef(isTranslationOn);
  const [liveCaptionOriginal, setLiveCaptionOriginal] = useState('');
  const [liveCaptionTranslated, setLiveCaptionTranslated] = useState('');
  const [isCaptionTranslating, setIsCaptionTranslating] = useState(false);

  useEffect(() => {
    isTranslationOnRef.current = isTranslationOn;
  }, [isTranslationOn]);

  // Detect remote video activity
  useEffect(() => {
    if (remoteStream) {
      const updateVideoStatus = () => {
        const hasVideo = remoteStream.getVideoTracks().some(track => track.enabled && track.readyState === 'live');
        setIsRemoteVideoActive(hasVideo);
      };

      updateVideoStatus();
      remoteStream.addEventListener('addtrack', updateVideoStatus);
      remoteStream.addEventListener('removetrack', updateVideoStatus);

      // Also poll slightly because track enabled changes might not trigger events immediately
      const interval = setInterval(updateVideoStatus, 1000);

      return () => {
        remoteStream.removeEventListener('addtrack', updateVideoStatus);
        remoteStream.removeEventListener('removetrack', updateVideoStatus);
        clearInterval(interval);
      };
    }
  }, [remoteStream]);

  // Attach streams to video/audio elements
  useEffect(() => {
    if (localVideoRef.current && localStream && !isVideoOff) {
      localVideoRef.current.srcObject = localStream;
    }
    if (remoteStream) {
      if (remoteVideoRef.current && !isVideoOff) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        void remoteAudioRef.current.play().catch(() => { });
      }
    }
  }, [isVideoOff, localStream, remoteStream]);

  // Handle mute and video toggling
  useEffect(() => {
    webrtc.toggleAudio(!isMuted);
  }, [isMuted]);

  useEffect(() => {
    webrtc.toggleVideo(!isVideoOff);
  }, [isVideoOff]);

  useEffect(() => {
    const volume = isSpeaker ? 1.0 : 0.3;
    if (remoteVideoRef.current) remoteVideoRef.current.volume = volume;
    if (remoteAudioRef.current) remoteAudioRef.current.volume = volume;
  }, [isSpeaker]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (callStatus === 'connected') {
      setCallDuration(0);
      interval = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [callStatus]);

  const handleEndCall = async () => {
    try {
      await webrtc.endCall();
      setCallStatus('ended');

      if (auth.currentUser) {
        const transcriptText = callTranscriptRef.current.length > 0
          ? callTranscriptRef.current.join('\n')
          : `A ${type} call between ${auth.currentUser.displayName || 'User'} and ${contactName} lasting ${formatTime(callDuration)}. No live transcript was captured.`;

        getFastSummary(transcriptText).then(async (aiSummary) => {
          if (auth.currentUser) {
            const callData = {
              contactName,
              contactId: contactId || 'unknown',
              type,
              status: 'completed',
              direction: incomingCallId ? 'incoming' : 'outgoing',
              callerId: incomingCallId ? (contactId || 'unknown') : auth.currentUser.uid,
              startTime: serverTimestamp(),
              duration: callDuration,
              participants: [auth.currentUser.uid, contactId || 'unknown'],
              summary: aiSummary || `Call with ${contactName} completed.`
            };
            await databaseService.addDocument(`users/${auth.currentUser.uid}/calls`, callData);
            if (aiSummary) {
              await addDoc(collection(db, 'users', auth.currentUser.uid, 'recordings'), {
                callId: 'call_' + Date.now(),
                ownerId: auth.currentUser.uid,
                duration: callDuration,
                timestamp: serverTimestamp(),
                url: '#',
                summary: aiSummary
              });
            }
          }
        }).catch(err => console.error("Background summary failed", err));
      }
    } catch (e) {
      console.error("Error ending call:", e);
    } finally {
      onEnd();
    }
  };

  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(
      collection(db, 'users', auth.currentUser.uid, 'ai_memory'),
      orderBy('timestamp', 'desc'),
      limit(5)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setMemories(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    });
    return () => unsubscribe();
  }, []);

  // Speech recognition: transcript + optional live translation captions
  const startSpeechRecognition = () => {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    recognitionRef.current?.stop();
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = speechLangForCode(
      isTranslationOnRef.current ? sourceLang.code : 'en'
    );

    recognition.onresult = (event: any) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }

      const line = (finalText || interim).trim();
      if (!line) return;

      if (isTranslationOnRef.current) {
        setLiveCaptionOriginal(line);
        if (finalText.trim()) {
          callTranscriptRef.current.push(finalText.trim());
          setIsCaptionTranslating(true);
          void translateUtterance(finalText.trim(), sourceLang.name, targetLang.name)
            .then((translated) => setLiveCaptionTranslated(translated))
            .catch(() => setLiveCaptionTranslated(line))
            .finally(() => setIsCaptionTranslating(false));
        }
      } else if (finalText.trim()) {
        callTranscriptRef.current.push(finalText.trim());
      }
    };

    recognition.onerror = () => { /* non-fatal */ };
    try {
      recognition.start();
      recognitionRef.current = recognition;
    } catch {
      /* mic may be busy with WebRTC */
    }
  };

  useEffect(() => {
    if (callStatus !== 'connected') return;
    startSpeechRecognition();
    return () => {
      recognitionRef.current?.stop();
    };
  }, [callStatus, isTranslationOn, sourceLang.code, targetLang.code]);

  // Request media permissions only when the actual call is being initiated
  useEffect(() => {
    const initCall = async () => {
      try {
        // Set up error handler
        webrtc.setOnError((error) => {
          console.error("Call error:", error);
          // Delay error message display by 60 seconds to allow connection attempts
          setTimeout(() => {
            setErrorMessage(error);
            setTimeout(() => {
              onEnd();
            }, 2000);
          }, 60000);
        });

        webrtc.setOnConnected(() => {
          setCallStatus('connected');
        });

        // Request media permissions only when user actually initiates/joins the call
        const { localStream, remoteStream } = await webrtc.startLocalStream(type);
        setLocalStream(localStream);
        setRemoteStream(remoteStream);

        if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;

        if (auth.currentUser) {
          const crypto = CryptoService.getInstance();
          const publicKey = await crypto.ensureKeyPair();
          await setDoc(doc(db, 'users', auth.currentUser.uid), { publicKey }, { merge: true });
        }

        // Create or join the actual call only after media permissions are granted
        if (incomingCallId && auth.currentUser) {
          const result = await webrtc.joinCall(incomingCallId, auth.currentUser.uid);
          if ((result as { error?: string }).error) {
            setErrorMessage('Unable to connect');
            return;
          }
          if (result.unsubscribers) {
            unsubscribersRef.current.push(...result.unsubscribers);
          }
        } else if (auth.currentUser && contactId) {
          const result = await webrtc.createCall(auth.currentUser.uid, contactId, type);
          if (result.unsubscribers) {
            unsubscribersRef.current.push(...result.unsubscribers);
          }
        } else {
          setErrorMessage('Missing contact for this call');
          return;
        }

        const unsubEnded = webrtc.onCallEnded(() => {
          onEnd();
        });
        if (unsubEnded) {
          unsubscribersRef.current.push(unsubEnded);
        }
      } catch (err) {
        console.error("Call Init Error:", err);
        setErrorMessage("Failed to initialize call");
      }
    };

    initCall();

    return () => {
      recognitionRef.current?.stop();
      unsubscribersRef.current.forEach(unsub => unsub?.());
      unsubscribersRef.current = [];
      void webrtc.endCall();
    };
  }, [type, contactId, incomingCallId]);

  useEffect(() => {
    const interval = setInterval(() => {
      setWaveform(prev => prev.map(() => Math.random() * 40 + 10));
    }, 100);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let interval: any;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } else {
      setRecordingTime(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const handleToggleRecording = async () => {
    if (isRecording) {
      if (auth.currentUser) {
        try {
          // Generate a more realistic summary using Gemini
          // In a real app, we would pass the actual transcript here.
          // For now, we'll simulate a transcript based on the call context.
          const transcriptText = callTranscriptRef.current.length > 0
            ? callTranscriptRef.current.join('\n')
            : `Recorded ${type} call with ${contactName}, duration ${formatTime(recordingTime)}. Languages: ${sourceLang.name} → ${targetLang.name}.`;

          const aiSummary = await getFastSummary(transcriptText);

          await addDoc(collection(db, 'users', auth.currentUser.uid, 'recordings'), {
            callId: 'call_' + Date.now(),
            ownerId: auth.currentUser.uid,
            duration: recordingTime,
            timestamp: serverTimestamp(),
            url: 'https://example.com/recording.mp3',
            summary: aiSummary || `Damai Summary: Call with ${contactName} completed.`
          });
        } catch (e) {
          console.error("Error saving recording:", e);
        }
      }
    }
    setIsRecording(!isRecording);
  };

  const handleToggleScreenShare = async () => {
    try {
      const stream = await webrtc.toggleScreenShare(!isScreenSharing);
      setIsScreenSharing(!isScreenSharing);
      if (stream && localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      } else if (!stream && localVideoRef.current && localStream) {
        localVideoRef.current.srcObject = localStream;
      }
    } catch (err) {
      console.error("Screen Share Error:", err);
    }
  };

  const handleToggleNoiseCancellation = async () => {
    setIsNoiseCancellationOn(!isNoiseCancellationOn);
    // In a real implementation, we would re-acquire the stream with different constraints
    // or use a Web Audio API node for processing.
    // For this demo, we toggle the state.
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 bg-[#1a1a1a] z-[200] flex flex-col overflow-hidden text-white font-sans">

      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-black/40 backdrop-blur-md z-20">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-emerald-500 rounded-md">
            <Shield size={14} className="text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-bold flex items-center gap-1.5">
              Dcalls {type} call
              <ShieldCheck size={12} className="text-emerald-500" />
            </span>
            <span className="text-[10px] text-gray-400">ID: 456-789-123 • {callStatus === 'connected' ? formatTime(callDuration) : callStatus}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded text-[10px] font-bold transition-colors">View</button>
          <button className="p-1.5 hover:bg-white/10 rounded transition-colors"><Maximize2 size={16} /></button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 relative flex items-center justify-center bg-black">
        {isVideoOff ? (
          <div className="flex flex-col items-center justify-center gap-12 w-full h-full">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="relative"
            >
              <div className="w-48 h-48 rounded-full bg-gradient-to-br from-purple-600/20 to-indigo-600/20 border-4 border-white/10 flex items-center justify-center overflow-hidden shadow-2xl relative z-10">
                <img
                  src={contactPhoto || `https://picsum.photos/seed/${contactName}/400/400`}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>
              {/* Animated Rings */}
              <div className="absolute inset-0 rounded-full border border-purple-500/30 animate-[ping_3s_linear_infinite]" />
              <div className="absolute inset-0 rounded-full border border-indigo-500/20 animate-[ping_2s_linear_infinite]" />
            </motion.div>

            <div className="text-center space-y-4">
              <div className="flex flex-col items-center gap-2 mb-4">
                <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                  <ShieldCheck size={14} className="text-emerald-500" />
                  <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">End-to-End Encrypted</span>
                </div>
              </div>
              <h2 className="text-4xl font-bold tracking-tighter">{contactName}</h2>
              <div className="flex flex-col items-center gap-2">
                <p className="text-2xl font-mono text-white/90 tracking-widest">
                  {callStatus === 'connected' ? formatTime(callDuration) : callStatus}
                </p>
                <div className="flex items-center justify-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <p className="text-gray-400 font-medium uppercase tracking-[0.2em] text-xs">
                    {isRecording ? `Recording Session (${formatTime(recordingTime)})` : "Secure Voice Call"}
                  </p>
                </div>
              </div>
            </div>

            {!isRecording && (
              <motion.button
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                onClick={handleEndCall}
                className="flex items-center gap-4 px-12 py-5 bg-red-600 hover:bg-red-500 rounded-full font-bold text-lg transition-all active:scale-95 shadow-2xl shadow-red-600/40"
              >
                <Phone size={28} />
                Hang Up
              </motion.button>
            )}
          </div>
        ) : (
          <div className="w-full h-full relative bg-black">
            {/* Remote Video */}
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />

            {isRecording && (
              <div className="absolute top-20 right-6 flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full border border-red-500/30 z-30">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-red-500">REC {formatTime(recordingTime)}</span>
              </div>
            )}
            {!isRemoteVideoActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/50 backdrop-blur-md">
                <div className="w-32 h-32 rounded-full bg-white/5 flex items-center justify-center mb-6 animate-pulse">
                  <Users size={48} className="text-gray-600" />
                </div>
                <p className="text-lg font-medium text-gray-400">
                  {callStatus === 'connecting' ? 'Connecting...' : `${contactName} has video off`}
                </p>
              </div>
            )}

            {/* Local Video (PIP) */}
            <div className="absolute top-6 right-6 w-56 h-36 bg-black/40 border border-white/10 rounded-2xl overflow-hidden shadow-2xl z-10 group">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={cn(
                  "w-full h-full object-cover transition-all duration-500",
                  virtualBackground === 'blur' && "blur-md scale-110",
                  virtualBackground === 'image' && "sepia brightness-110"
                )}
              />
              <div className="absolute bottom-3 left-3 text-[10px] font-bold bg-black/60 px-3 py-1 rounded-full backdrop-blur-md border border-white/5">
                Me {isScreenSharing ? '(Screen)' : '(Local)'}
              </div>
            </div>

            <div className="absolute bottom-10 left-10 text-lg font-bold bg-black/60 px-6 py-3 rounded-full backdrop-blur-md border border-white/10 flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
              {contactName}
            </div>
          </div>
        )}

        {/* Damai Memory Sidebar */}
        <AnimatePresence>
          {showMemory && (
            <motion.div
              initial={{ x: 300, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 300, opacity: 0 }}
              className="absolute top-0 right-0 bottom-0 w-80 bg-[#1a1a1a]/95 backdrop-blur-2xl border-l border-white/10 z-40 flex flex-col shadow-2xl"
            >
              <div className="p-4 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DcallsIcon size={16} className="text-purple-400" />
                  <h3 className="font-bold text-sm">Damai Memory</h3>
                </div>
                <button onClick={() => setShowMemory(false)} className="p-1 hover:bg-white/5 rounded-full transition-colors">
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {memories.length === 0 ? (
                  <div className="text-center py-10 opacity-50">
                    <p className="text-xs">No memories found for this session.</p>
                  </div>
                ) : (
                  memories.map((m) => (
                    <div key={m.id} className="p-3 rounded-xl bg-white/5 border border-white/5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-purple-400 uppercase tracking-widest truncate max-w-[150px]">
                          {m.topic}
                        </span>
                        <span className="text-[8px] text-gray-500">
                          {m.timestamp?.toDate?.()?.toLocaleTimeString?.([], { hour: '2-digit', minute: '2-digit' }) ?? ''}
                        </span>
                      </div>
                      <p className="text-xs text-gray-300 leading-relaxed line-clamp-3">
                        {m.content}
                      </p>
                    </div>
                  ))
                )}
              </div>
              <div className="p-4 bg-purple-600/10 border-t border-white/5">
                <p className="text-[9px] text-purple-400 text-center font-medium">
                  Damai uses these memories to provide context-aware help during your calls.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Translation Overlay */}
        <AnimatePresence>
          {isTranslationOn && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="absolute bottom-24 left-1/2 -translate-x-1/2 w-full max-w-2xl px-6 z-30"
            >
              <div className="bg-black/60 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <DcallsIcon size={12} className="text-purple-400" />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-purple-400">
                      Damai Live Translation
                    </span>
                  </div>
                  <span className="text-[9px] text-gray-400 font-medium">
                    {sourceLang.flag} {sourceLang.name} → {targetLang.flag} {targetLang.name}
                  </span>
                </div>
                {liveCaptionOriginal ? (
                  <>
                    <p className="text-sm text-gray-400 text-center">{liveCaptionOriginal}</p>
                    <p className="text-lg font-medium text-center text-white">
                      {isCaptionTranslating ? 'Translating…' : (liveCaptionTranslated || '…')}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-gray-400 text-center">
                    Listening for speech… Speak clearly in {sourceLang.name}.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setIsLangSelectorOpen(true)}
                  className="w-full text-[10px] font-bold uppercase tracking-widest text-purple-300 hover:text-purple-200"
                >
                  Change languages
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Hidden audio for voice calls — plays remote WebRTC audio */}
        <audio ref={remoteAudioRef} autoPlay playsInline className="sr-only" />
      </div>

      {/* Bottom Control Bar */}
      <div className="bg-[#1a1a1a] px-6 py-4 flex items-center justify-between z-20 border-t border-white/5">
        <div className="flex items-center gap-2">
          <div className="flex items-center p-1 bg-white/5 rounded-xl border border-white/5">
            <ZoomButton
              onClick={() => setIsMuted(!isMuted)}
              icon={isMuted ? <MicOff size={22} className="text-red-500" /> : <Mic size={22} className="text-white" />}
              label={isMuted ? "Unmute" : "Mute"}
              badge={isMuted ? "OFF" : undefined}
            />
            {type === 'video' && (
              <ZoomButton
                onClick={() => setIsVideoOff(!isVideoOff)}
                icon={isVideoOff ? <VideoOff size={22} className="text-red-500" /> : <Video size={22} className="text-white" />}
                label={isVideoOff ? "Start Video" : "Stop Video"}
                badge={isVideoOff ? "OFF" : undefined}
              />
            )}
            <ZoomButton
              onClick={() => setIsSpeaker(!isSpeaker)}
              icon={isSpeaker ? <Volume2 size={22} className="text-emerald-400" /> : <VolumeX size={22} className="text-gray-400" />}
              label={isSpeaker ? "Speaker" : "Handset"}
              badge={isSpeaker ? "ON" : "EAR"}
            />
          </div>

          <div className="h-8 w-px bg-white/10 mx-2" />

          <div className="flex items-center p-1 bg-white/5 rounded-xl border border-white/5">
            <ZoomButton
              onClick={() => (isTranslationOn ? setIsTranslationOn(false) : setIsLangSelectorOpen(true))}
              icon={<Languages size={20} className={isTranslationOn ? "text-purple-400" : "text-gray-400"} />}
              label="Translate"
              badge={isTranslationOn ? "ON" : undefined}
            />
            <ZoomButton
              onClick={handleToggleNoiseCancellation}
              icon={<Wind size={20} className={isNoiseCancellationOn ? "text-indigo-400" : "text-gray-400"} />}
              label="AI Noise"
              badge={isNoiseCancellationOn ? "ACTIVE" : undefined}
            />
            <ZoomButton
              onClick={() => setVirtualBackground(prev => prev === 'none' ? 'blur' : prev === 'blur' ? 'image' : 'none')}
              icon={<DcallsIcon size={20} className={virtualBackground !== 'none' ? "text-purple-400" : "text-gray-400"} />}
              label="Visuals"
              badge={virtualBackground !== 'none' ? virtualBackground.toUpperCase() : undefined}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center p-1 bg-white/5 rounded-xl border border-white/5">
            <ZoomButton
              onClick={() => setShowParticipants(!showParticipants)}
              icon={<Users size={20} className="text-gray-300" />}
              label="People"
              badge={participants.length.toString()}
            />
            <ZoomButton
              onClick={() => setShowChat(!showChat)}
              icon={<MessageCircle size={20} className="text-gray-300" />}
              label="Chat"
            />
            <ZoomButton
              onClick={handleToggleScreenShare}
              icon={<Share size={20} className={isScreenSharing ? "text-emerald-500" : "text-gray-300"} />}
              label="Share"
              badge={isScreenSharing ? "LIVE" : undefined}
            />
            <ZoomButton
              onClick={handleToggleRecording}
              icon={isRecording ? <Square size={16} className="text-red-500" /> : <Circle size={16} className="text-gray-300" />}
              label="Record"
              badge={isRecording ? formatTime(recordingTime) : undefined}
            />
          </div>

          <button
            onClick={handleEndCall}
            className="ml-4 px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold transition-all active:scale-95 flex items-center gap-3 shadow-lg shadow-red-600/20"
          >
            <PhoneOff size={20} />
            <span className="hidden sm:inline">End Call</span>
          </button>
        </div>
      </div>

      {/* Participants Modal */}
      <AnimatePresence>
        {showParticipants && (
          <motion.div
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            className="fixed top-12 right-4 bottom-24 w-80 bg-[#1a1a1a] border border-white/10 rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden"
          >
            <div className="p-4 border-b border-white/5 flex items-center justify-between bg-white/5">
              <h3 className="font-bold">Participants ({participants.length})</h3>
              <button
                onClick={() => setShowParticipants(false)}
                className="p-1.5 hover:bg-white/10 rounded-full transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {participants.map((p) => (
                <div key={p.id} className="flex items-center gap-3 group">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 p-0.5">
                    <div className="w-full h-full rounded-[10px] bg-[#1a1a1a] flex items-center justify-center overflow-hidden">
                      {p.photo ? (
                        <img src={p.photo} alt={p.name} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-xs font-bold">{p.name.substring(0, 2).toUpperCase()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">{p.name}</p>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">
                      {p.id === 'me' ? 'Host' : 'Participant'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button className="p-1.5 hover:bg-white/10 rounded-lg text-gray-400"><Mic size={14} /></button>
                    <button className="p-1.5 hover:bg-white/10 rounded-lg text-gray-400"><Video size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-white/5 bg-white/[0.02]">
              <button className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-xs font-bold uppercase tracking-widest transition-colors">
                Invite Others
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Call Summary Overlay */}
      <AnimatePresence>
        {showSummary && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute inset-0 z-[500] bg-black/90 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-[#1a1a1a] border border-white/10 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-purple-600/10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-purple-600 flex items-center justify-center">
                    <DcallsIcon size={20} className="text-white" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">Call Summary</h3>
                    <p className="text-[10px] text-purple-400 font-bold uppercase tracking-widest">Generated by Damai AI</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-gray-400">{formatTime(callDuration)}</p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest">Duration</p>
                </div>
              </div>

              <div className="p-8 space-y-8">
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-widest">
                    <MessageCircle size={14} />
                    Key Takeaways
                  </div>
                  <div className="p-6 bg-white/5 rounded-2xl border border-white/5 text-sm leading-relaxed text-gray-300 italic">
                    "{finalSummary}"
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Rate this summary</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          if (!auth.currentUser) return;
                          await addDoc(collection(db, 'users', auth.currentUser.uid, 'feedback'), {
                            type: 'call_summary',
                            rating: 1,
                            summary: finalSummary,
                            timestamp: serverTimestamp()
                          });
                          onEnd();
                        }}
                        className="p-3 hover:bg-emerald-500/10 rounded-xl text-gray-500 hover:text-emerald-500 transition-all border border-transparent hover:border-emerald-500/20"
                        title="Thumbs Up"
                      >
                        <ThumbsUp size={24} />
                      </button>
                      <button
                        onClick={async () => {
                          if (!auth.currentUser) return;
                          await addDoc(collection(db, 'users', auth.currentUser.uid, 'feedback'), {
                            type: 'call_summary',
                            rating: -1,
                            summary: finalSummary,
                            timestamp: serverTimestamp()
                          });
                          onEnd();
                        }}
                        className="p-3 hover:bg-red-500/10 rounded-xl text-gray-500 hover:text-red-500 transition-all border border-transparent hover:border-red-500/20"
                        title="Thumbs Down"
                      >
                        <ThumbsDown size={24} />
                      </button>
                      <button
                        onClick={() => setShowFeedbackModal(true)}
                        className="p-3 hover:bg-purple-500/10 rounded-xl text-gray-500 hover:text-purple-400 transition-all border border-transparent hover:border-purple-500/20"
                        title="Detailed Feedback"
                      >
                        <MessageSquare size={24} />
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  onClick={onEnd}
                  className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl font-bold transition-all active:scale-[0.98]"
                >
                  Done
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modals */}
      <FeedbackModal
        isOpen={showFeedbackModal}
        onClose={() => {
          setShowFeedbackModal(false);
          onEnd();
        }}
        onSubmit={async (rating, comment) => {
          if (!auth.currentUser) return;
          await addDoc(collection(db, 'users', auth.currentUser.uid, 'feedback'), {
            type: 'call_summary',
            rating,
            comment,
            summary: finalSummary,
            timestamp: serverTimestamp()
          });
        }}
        title="How was the call summary?"
        description="Your feedback helps us improve Damai's summarization and understanding."
      />

      {/* Language Selection Modal */}
      <AnimatePresence>
        {isLangSelectorOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#1a1a1a] border border-white/10 rounded-3xl w-full max-w-md overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-xl font-bold">Translation Settings</h3>
                <button
                  onClick={() => setIsLangSelectorOpen(false)}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="p-6 space-y-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Source Language</label>
                  <div className="grid grid-cols-2 gap-2">
                    {LANGUAGES.map(lang => (
                      <button
                        key={lang.code}
                        onClick={() => setSourceLang(lang)}
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-xl border transition-all",
                          sourceLang.code === lang.code
                            ? "bg-purple-500/20 border-purple-500/50 text-white"
                            : "bg-white/5 border-transparent text-gray-400 hover:bg-white/10"
                        )}
                      >
                        <span className="text-xl">{lang.flag}</span>
                        <span className="text-sm font-medium">{lang.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex justify-center">
                  <div className="p-2 bg-white/5 rounded-full">
                    <Globe size={20} className="text-purple-400" />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Target Language</label>
                  <div className="grid grid-cols-2 gap-2">
                    {LANGUAGES.map(lang => (
                      <button
                        key={lang.code}
                        onClick={() => setTargetLang(lang)}
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-xl border transition-all",
                          targetLang.code === lang.code
                            ? "bg-emerald-500/20 border-emerald-500/50 text-white"
                            : "bg-white/5 border-transparent text-gray-400 hover:bg-white/10"
                        )}
                      >
                        <span className="text-xl">{lang.flag}</span>
                        <span className="text-sm font-medium">{lang.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setIsTranslationOn(true);
                    setIsLangSelectorOpen(false);
                    setLiveCaptionOriginal('');
                    setLiveCaptionTranslated('');
                    if (callStatus === 'connected') {
                      startSpeechRecognition();
                    }
                  }}
                  className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-2xl font-bold shadow-lg shadow-purple-500/20 active:scale-[0.98] transition-all"
                >
                  Start Real-time Translation
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const ZoomButton = ({ icon, label, onClick, hasArrow, badge }: { icon: React.ReactNode, label: string, onClick?: () => void, hasArrow?: boolean, badge?: string }) => (
  <button
    onClick={onClick}
    className="flex flex-col items-center justify-center w-16 h-12 hover:bg-white/10 rounded-lg transition-colors group relative"
  >
    <div className="relative">
      {icon}
      {badge && (
        <span className={cn(
          "absolute -top-2 -right-2 text-[7px] font-black px-1 rounded-sm shadow-sm",
          badge === "ON" ? "bg-emerald-500 text-white" :
            badge === "AI" ? "bg-indigo-500 text-white" :
              "bg-red-500 text-white"
        )}>
          {badge}
        </span>
      )}
    </div>
    <span className="text-[9px] mt-1 text-gray-300 group-hover:text-white transition-colors">{label}</span>
    {hasArrow && (
      <ChevronDown size={8} className="absolute bottom-1 right-1 text-gray-500" />
    )}
  </button>
);
