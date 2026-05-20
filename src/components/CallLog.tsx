import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Phone, Video, PhoneMissed, Info, FileText, X, List, PhoneIncoming, PhoneOutgoing, Trash2, AlertTriangle } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import { format } from 'date-fns';
import { CallRecord, Recording } from '../types';
import { collection, query, where, orderBy, onSnapshot, doc, getDoc, deleteDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface CallLogProps {
  calls: CallRecord[];
}

export const CallLog: React.FC<CallLogProps> = ({ calls }) => {
  const [selectedSummary, setSelectedSummary] = useState<Recording | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [participantNames, setParticipantNames] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<'all' | 'missed' | 'incoming' | 'outgoing'>('all');
  const [isInitializing, setIsInitializing] = useState(true);
  const [callToDelete, setCallToDelete] = useState<CallRecord | null>(null);
  const [deletingCall, setDeletingCall] = useState(false);

  useEffect(() => {
    // Simulate asynchronous initialization of filters/preferences
    const init = async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
      setIsInitializing(false);
    };
    init();
  }, []);

  useEffect(() => {
    const fetchNames = async () => {
      const newNames: Record<string, string> = { ...participantNames };
      let changed = false;

      for (const call of calls) {
        const otherId = call.participants.find(p => p !== auth.currentUser?.uid);
        if (otherId && !newNames[otherId]) {
          const userDoc = await getDoc(doc(db, 'users', otherId));
          if (userDoc.exists()) {
            newNames[otherId] = userDoc.data().displayName || 'User';
            changed = true;
          }
        }
      }

      if (changed) {
        setParticipantNames(newNames);
      }
    };

    if (calls.length > 0) {
      fetchNames();
    }
  }, [calls]);

  useEffect(() => {
    if (!auth.currentUser) return;

    const q = query(
      collection(db, 'users', auth.currentUser.uid, 'recordings'),
      orderBy('timestamp', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const recs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Recording));
      setRecordings(recs);
    });

    return () => unsubscribe();
  }, []);

  const filteredCalls = calls.filter(call => {
    if (filter === 'all') return true;
    if (filter === 'missed') return call.status === 'missed';
    if (filter === 'incoming') return call.direction === 'incoming';
    if (filter === 'outgoing') return call.direction === 'outgoing';
    return true;
  });

  const handleDeleteCall = async (call: CallRecord) => {
    if (!auth.currentUser) return;
    setDeletingCall(true);
    try {
      // Delete the call record
      await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'calls', call.id));
      
      // Delete associated recording if it exists
      const recording = recordings.find(r => r.callId === call.id);
      if (recording) {
        await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'recordings', recording.id));
      }
      
      setCallToDelete(null);
    } catch (error) {
      console.error("Error deleting call:", error);
    } finally {
      setDeletingCall(false);
    }
  };

  if (isInitializing) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-[10px] text-gray-500 uppercase tracking-[0.2em] font-bold">Synchronizing Logs...</p>
      </div>
    );
  }

  if (filteredCalls.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex gap-2 p-4 border-b border-white/5 overflow-x-auto no-scrollbar">
          {(['all', 'missed', 'incoming', 'outgoing'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all whitespace-nowrap",
                filter === f 
                  ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" 
                  : "bg-white/5 text-gray-500 hover:bg-white/10"
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex flex-col items-center justify-center flex-1 text-gray-500 gap-4 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center">
            <Phone size={32} className="opacity-20" />
          </div>
          <p className="text-sm">No {filter !== 'all' ? filter : ''} calls found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex gap-2 p-4 border-b border-white/5 overflow-x-auto no-scrollbar sticky top-0 bg-[#0a0a0a] z-10">
        {(['all', 'missed', 'incoming', 'outgoing'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all whitespace-nowrap",
              filter === f 
                ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" 
                : "bg-white/5 text-gray-500 hover:bg-white/10"
            )}
          >
            {f}
          </button>
        ))}
      </div>
      {filteredCalls.map((call, index) => {
        const recording = recordings.find(r => r.callId === call.id);
        const otherId = call.participants.find(p => p !== auth.currentUser?.uid);
        const contactName = otherId ? participantNames[otherId] || 'Loading...' : 'User';
        const isIncoming = call.direction === 'incoming';
        
        return (
          <motion.div
            key={call.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.05 }}
            className="flex items-center gap-4 p-4 hover:bg-white/5 transition-colors border-b border-white/5"
          >
            <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-xl border border-white/5 relative">
              {call.type === 'video' ? <Video size={20} className="text-indigo-400" /> : <Phone size={20} className="text-emerald-400" />}
              {call.direction && (
                <div className={cn(
                  "absolute -bottom-1 -right-1 p-1 rounded-full text-white",
                  isIncoming ? "bg-blue-500" : "bg-emerald-500"
                )}>
                  {isIncoming ? <PhoneIncoming size={8} /> : <PhoneOutgoing size={8} />}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline mb-1">
                <h3 className={cn(
                  "font-medium truncate",
                  call.status === 'missed' ? "text-red-400" : "text-white"
                )}>
                  {call.status === 'missed' ? 'Missed Call' : contactName}
                </h3>
                <span className="text-[10px] text-gray-500 uppercase tracking-tighter">
                  {format(call.startTime.toDate(), 'MMM d, HH:mm')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {call.status === 'missed' ? <PhoneMissed size={12} className="text-red-500" /> : isIncoming ? <PhoneIncoming size={12} className="text-blue-500" /> : <PhoneOutgoing size={12} className="text-emerald-500" />}
                <p className="text-xs text-gray-500 uppercase tracking-widest">
                  {call.type} • {call.status}
                </p>
              </div>
            </div>
            
            {recording && (
              <button 
                onClick={() => setSelectedSummary(recording)}
                className="p-2.5 bg-purple-500/10 text-purple-400 rounded-xl hover:bg-purple-500/20 transition-all flex items-center gap-2 border border-purple-500/20"
              >
                <FileText size={16} />
                <span className="text-[9px] font-bold uppercase tracking-widest">Summary</span>
              </button>
            )}
            
            <button 
              onClick={() => setCallToDelete(call)}
              className="p-2 hover:bg-red-500/10 rounded-full transition-colors text-gray-600 hover:text-red-400"
              title="Delete call"
            >
              <Trash2 size={18} />
            </button>
            
            <button className="p-2 hover:bg-white/10 rounded-full transition-colors text-gray-400">
              <Info size={18} />
            </button>
          </motion.div>
        );
      })}

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
                    {selectedSummary.summary.split('. ').map((point, i) => point && (
                      <motion.div 
                        key={i}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.1 }}
                        className="flex gap-3 items-start"
                      >
                        <div className="w-1.5 h-1.5 rounded-full bg-purple-500 mt-1.5 flex-shrink-0" />
                        <p className="text-sm text-gray-300 leading-relaxed">
                          {point.replace('Damai Summary: ', '')}
                        </p>
                      </motion.div>
                    ))}
                  </div>
                </div>

                <div className="pt-4 border-t border-white/5">
                  <div className="flex justify-between items-center text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                    <span>Duration: {Math.floor(selectedSummary.duration / 60)}m {selectedSummary.duration % 60}s</span>
                    <span>{format(selectedSummary.timestamp.toDate(), 'MMM d, yyyy')}</span>
                  </div>
                </div>

                <button
                  onClick={() => setSelectedSummary(null)}
                  className="w-full py-4 bg-white text-black rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-gray-200 transition-all active:scale-95"
                >
                  Close Summary
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Call Confirmation Modal */}
      <AnimatePresence>
        {callToDelete && (
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
                  <h3 className="text-xl font-bold text-white">Delete Call?</h3>
                  <p className="text-sm text-gray-400">
                    Are you sure you want to delete this {callToDelete.type} call from {format(callToDelete.startTime.toDate(), 'MMM d')}? {callToDelete.status === 'missed' ? 'This was a missed call.' : ''} This action cannot be undone.
                  </p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={() => setCallToDelete(null)}
                  className="flex-1 py-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white text-sm font-bold transition-all active:scale-95"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteCall(callToDelete)}
                  disabled={deletingCall}
                  className="flex-1 py-3 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-2xl text-white text-sm font-bold transition-all active:scale-95 shadow-lg shadow-red-600/20"
                >
                  {deletingCall ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
