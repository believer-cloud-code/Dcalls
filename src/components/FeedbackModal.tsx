import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Star, MessageSquare, Send, CheckCircle2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (rating: number, comment: string) => Promise<void>;
  title?: string;
  description?: string;
  initialRating?: number;
}

export const FeedbackModal: React.FC<FeedbackModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  title = "How was Damai's response?",
  description = "Your feedback helps us improve Damai's intelligence and personalization.",
  initialRating = 0
}) => {
  const [rating, setRating] = useState(initialRating);
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async () => {
    if (rating === 0) return;
    setIsSubmitting(true);
    try {
      await onSubmit(rating, comment);
      setIsSuccess(true);
      setTimeout(() => {
        onClose();
        // Reset after modal closes
        setTimeout(() => {
          setIsSuccess(false);
          setRating(0);
          setComment('');
        }, 300);
      }, 2000);
    } catch (error) {
      console.error("Feedback submission failed:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          />
          
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="relative w-full max-w-md bg-[#1a1a1a] border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
          >
            {isSuccess ? (
              <div className="p-12 flex flex-col items-center text-center space-y-4">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-500"
                >
                  <CheckCircle2 size={48} />
                </motion.div>
                <div className="space-y-2">
                  <h3 className="text-2xl font-bold text-white">Thank You!</h3>
                  <p className="text-gray-400">Your feedback has been recorded and will be used to improve Damai.</p>
                </div>
              </div>
            ) : (
              <>
                <div className="p-6 border-b border-white/5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-600/20 flex items-center justify-center text-purple-400">
                      <MessageSquare size={20} />
                    </div>
                    <div>
                      <h3 className="font-bold text-white">{title}</h3>
                      <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">AI Feedback Loop</p>
                    </div>
                  </div>
                  <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full text-gray-500 transition-colors">
                    <X size={20} />
                  </button>
                </div>

                <div className="p-6 space-y-6">
                  <p className="text-sm text-gray-400 leading-relaxed">
                    {description}
                  </p>

                  <div className="space-y-3">
                    <label className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">Rating</label>
                    <div className="flex items-center justify-between gap-2">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          onClick={() => setRating(star)}
                          className={cn(
                            "flex-1 py-3 rounded-2xl border transition-all flex flex-col items-center gap-1",
                            rating >= star 
                              ? "bg-purple-600/20 border-purple-500/50 text-purple-400" 
                              : "bg-white/5 border-transparent text-gray-600 hover:bg-white/10"
                          )}
                        >
                          <Star size={20} fill={rating >= star ? "currentColor" : "none"} />
                          <span className="text-[10px] font-bold">{star}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">Detailed Comments (Optional)</label>
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="What could be better? What did you like?"
                      className="w-full h-32 bg-black/40 border border-white/5 rounded-2xl p-4 text-sm text-white placeholder:text-gray-700 focus:outline-none focus:border-purple-500/50 resize-none transition-all"
                    />
                  </div>

                  <button
                    onClick={handleSubmit}
                    disabled={rating === 0 || isSubmitting}
                    className={cn(
                      "w-full py-4 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all active:scale-[0.98]",
                      rating > 0 
                        ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg shadow-purple-500/20" 
                        : "bg-white/5 text-gray-500 cursor-not-allowed"
                    )}
                  >
                    {isSubmitting ? (
                      <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                    ) : (
                      <>
                        <Send size={18} />
                        Submit Feedback
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
