import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { DcallsIcon } from './DcallsIcon';
import { FileText, MessageSquare, Zap, Mic, List, X, Clock, Calendar } from 'lucide-react';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Recording } from '../types';
import { format } from 'date-fns';
import { DamaiChat } from './DamaiChat';
import { LiveTranscription } from './LiveTranscription';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const DamaiTab: React.FC = () => {
  const [recentSummaries, setRecentSummaries] = useState<Recording[]>([]);
  const [selectedSummary, setSelectedSummary] = useState<Recording | null>(null);
  const [activeCapability, setActiveCapability] = useState<'chat' | 'summaries' | 'replies' | 'voice' | 'transcription' | null>(null);

  useEffect(() => {
    if (!auth.currentUser) return;

    const q = query(
      collection(db, 'users', auth.currentUser.uid, 'recordings'),
      orderBy('timestamp', 'desc'),
      limit(3)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const recs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Recording));
      setRecentSummaries(recs);
    });

    return () => unsubscribe();
  }, []);

  const features = [
    {
      id: 'chat',
      title: "Personal Assistant",
      desc: "Chat with Damai for notes, scheduling, and tasks.",
      icon: <MessageSquare className="text-blue-400" />,
      color: "from-blue-500/20 to-indigo-500/20"
    },
    {
      id: 'transcription',
      title: "Live Transcription",
      desc: "Real-time audio transcription with AI insights.",
      icon: <Mic className="text-indigo-400" />,
      color: "from-indigo-500/20 to-purple-500/20"
    },
    {
      id: 'summaries',
      title: "Call Summaries",
      desc: "AI-generated bullet points of your recent discussions.",
      icon: <FileText className="text-purple-400" />,
      color: "from-purple-500/20 to-pink-500/20"
    },
    {
      id: 'replies',
      title: "Smart Replies",
      desc: "Personalized suggestions based on your typing style.",
      icon: <Zap className="text-amber-400" />,
      color: "from-amber-500/20 to-orange-500/20"
    },
    {
      id: 'voice',
      title: "Voice Cloning",
      desc: "Let Damai answer calls and take messages for you.",
      icon: <Mic className="text-emerald-400" />,
      color: "from-emerald-500/20 to-teal-500/20"
    }
  ];

  if (activeCapability === 'chat') {
    return <DamaiChat onClose={() => setActiveCapability(null)} />;
  }

  if (activeCapability === 'transcription') {
    return (
      <div className="fixed inset-0 bg-[#0a0a0a] z-[100] flex flex-col pt-16">
        <div className="absolute top-4 left-4 z-[110]">
          <button 
            onClick={() => setActiveCapability(null)}
            className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        <LiveTranscription />
      </div>
    );
  }

  if (activeCapability === 'summaries') {
    return (
      <div className="fixed inset-0 bg-[#0a0a0a] z-[100] flex flex-col">
        <div className="p-6 border-b border-white/5 flex items-center justify-between bg-[#121212]">
          <h2 className="text-xl font-bold text-white">Call Summaries</h2>
          <button 
            onClick={() => setActiveCapability(null)}
            className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {recentSummaries.length > 0 ? (
            recentSummaries.map((rec) => (
              <div 
                key={rec.id}
                onClick={() => {
                  setSelectedSummary(rec);
                  setActiveCapability(null);
                }}
                className="p-4 bg-purple-500/10 border border-purple-500/20 rounded-2xl cursor-pointer hover:bg-purple-500/20 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <FileText className="text-purple-400 flex-shrink-0 mt-1" size={20} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white truncate">Call Summary</p>
                    <p className="text-xs text-gray-400 mt-1 line-clamp-2">{rec.summary.replace('Damai Summary: ', '')}</p>
                    <p className="text-[10px] text-gray-500 mt-2">{format(rec.timestamp.toDate(), 'MMM d, yyyy')}</p>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3">
                <FileText size={48} className="mx-auto text-gray-600" />
                <p className="text-gray-400">No call summaries yet</p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (activeCapability === 'replies') {
    return (
      <div className="fixed inset-0 bg-[#0a0a0a] z-[100] flex flex-col items-center justify-center p-6">
        <div className="absolute top-4 left-4">
          <button 
            onClick={() => setActiveCapability(null)}
            className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        <div className="text-center space-y-4 max-w-sm">
          <Zap size={48} className="mx-auto text-amber-500" />
          <h2 className="text-2xl font-bold text-white">Smart Replies</h2>
          <p className="text-gray-400">Smart reply suggestions work automatically in chat messages. Type naturally and Damai will suggest quick responses based on context.</p>
          <button
            onClick={() => setActiveCapability(null)}
            className="mt-6 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-2xl text-white font-bold transition-all"
          >
            Got It
          </button>
        </div>
      </div>
    );
  }

  if (activeCapability === 'voice') {
    return (
      <div className="fixed inset-0 bg-[#0a0a0a] z-[100] flex flex-col items-center justify-center p-6">
        <div className="absolute top-4 left-4">
          <button 
            onClick={() => setActiveCapability(null)}
            className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        <div className="text-center space-y-4 max-w-sm">
          <Mic size={48} className="mx-auto text-emerald-500" />
          <h2 className="text-2xl font-bold text-white">Voice Cloning</h2>
          <p className="text-gray-400">Voice cloning allows Damai to answer calls and take messages with a natural voice. Configure in your Damai AI settings to enable this feature.</p>
          <button
            onClick={() => setActiveCapability(null)}
            className="mt-6 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-2xl text-white font-bold transition-all"
          >
            Got It
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8 pb-24">
      <header className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[10px] font-bold uppercase tracking-[0.2em] mb-2">
          <DcallsIcon size={12} />
          AI Powered
        </div>
        <h2 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white via-purple-200 to-white bg-clip-text text-transparent">
          Meet Damai
        </h2>
        <p className="text-gray-400 text-sm max-w-[280px] mx-auto">
          Your intelligent companion for seamless communication and productivity.
        </p>
      </header>

      <div className="grid gap-4">
        {features.map((f, i) => (
          <motion.button
            key={f.title}
            onClick={() => setActiveCapability(f.id as any)}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className={`flex items-start gap-4 p-5 rounded-3xl bg-gradient-to-br ${f.color} border border-white/5 text-left hover:scale-[1.02] transition-transform active:scale-[0.98]`}
          >
            <div className="p-3 rounded-2xl bg-[#0a0a0a]/50 border border-white/10">
              {f.icon}
            </div>
            <div className="space-y-1">
              <h3 className="font-semibold text-white">{f.title}</h3>
              <p className="text-xs text-gray-400 leading-relaxed">{f.desc}</p>
            </div>
          </motion.button>
        ))}
      </div>

      <div className="pt-4">
        <div className="p-6 rounded-[2rem] bg-[#121212] border border-white/5 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/10 blur-[50px] rounded-full -mr-16 -mt-16 group-hover:bg-purple-500/20 transition-colors" />
          <h4 className="text-sm font-bold uppercase tracking-widest text-gray-500 mb-6 flex items-center gap-2">
            <DcallsIcon size={14} className="text-purple-400" />
            Recent AI Insights
          </h4>
          
          <div className="space-y-6">
            {recentSummaries.length > 0 ? (
              recentSummaries.map((rec, i) => (
                <motion.button
                  key={rec.id}
                  onClick={() => setSelectedSummary(rec)}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.1 }}
                  className="w-full text-left space-y-2 group/item"
                >
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">Call Summary</span>
                    <span className="text-[9px] text-gray-600 uppercase tracking-tighter">{format(rec.timestamp.toDate(), 'MMM d')}</span>
                  </div>
                  <p className="text-xs text-gray-300 leading-relaxed line-clamp-2 group-hover/item:text-white transition-colors">
                    {rec.summary.replace('Damai Summary: ', '')}
                  </p>
                  <div className="h-[1px] w-full bg-white/5" />
                </motion.button>
              ))
            ) : (
              <div className="flex gap-3 items-start">
                <div className="w-1.5 h-1.5 rounded-full bg-purple-500 mt-1.5" />
                <p className="text-xs text-gray-300 leading-relaxed italic">
                  "You have no recent call summaries. Start a call and record it to see AI insights here."
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary Modal */}
      <AnimatePresence>
        {selectedSummary && (
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
              className="w-full max-w-md bg-[#121212] border border-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-gradient-to-r from-purple-500/10 to-transparent">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-purple-500/20 flex items-center justify-center text-purple-400">
                    <DcallsIcon size={20} />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">Call Summary</h3>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">AI Generated by Damai</p>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedSummary(null)}
                  className="p-2 hover:bg-white/5 rounded-xl text-gray-500 hover:text-white transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="p-8 space-y-6">
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-purple-400">
                    <List size={16} />
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Key Takeaways</span>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="markdown-body prose prose-invert prose-sm max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {selectedSummary.summary.replace('Damai Summary: ', '')}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-white/5 grid grid-cols-2 gap-4">
                  <div className="flex items-center gap-2 text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                    <Clock size={12} />
                    <span>{Math.floor(selectedSummary.duration / 60)}m {selectedSummary.duration % 60}s</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-gray-500 font-bold uppercase tracking-widest justify-end">
                    <Calendar size={12} />
                    <span>{format(selectedSummary.timestamp.toDate(), 'MMM d, yyyy')}</span>
                  </div>
                </div>

                <button
                  onClick={() => setSelectedSummary(null)}
                  className="w-full py-4 bg-white text-black rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-gray-200 transition-all active:scale-95"
                >
                  Close Insights
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
