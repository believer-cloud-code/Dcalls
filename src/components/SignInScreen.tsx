import React, { useState } from 'react';
import { motion } from 'motion/react';
import { ChevronLeft, Lock, Mail, LogIn } from 'lucide-react';

interface SignInScreenProps {
  onSignIn: (email: string, password: string) => Promise<void>;
  onResetPassword: (email: string) => Promise<void>;
  onBack: () => void;
}

export const SignInScreen: React.FC<SignInScreenProps> = ({ onSignIn, onResetPassword, onBack }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const run = async (action: () => Promise<void>) => {
    setLoading(true);
    setError('');
    setMessage('');
    try { await action(); } catch (err: any) {
      setError(err?.message || 'The request could not be completed.');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-[300] bg-[#0a0a0a] flex items-center justify-center p-6">
      <button onClick={onBack} className="absolute top-8 left-6 p-2 text-gray-400 hover:bg-white/5 rounded-full" aria-label="Go back"><ChevronLeft size={24} /></button>
      <motion.form initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} onSubmit={e => { e.preventDefault(); void run(() => onSignIn(email, password)); }} className="w-full max-w-sm space-y-5">
        <div className="text-center space-y-2">
          <div className="w-16 h-16 mx-auto rounded-3xl bg-indigo-500/15 flex items-center justify-center text-indigo-400"><LogIn size={28} /></div>
          <h2 className="text-3xl font-bold text-white">Welcome back</h2>
          <p className="text-sm text-gray-400">Sign in with your email address and password.</p>
        </div>
        <div className="space-y-2">
          <label className="text-[10px] uppercase tracking-widest text-gray-500 ml-3 flex items-center gap-2"><Mail size={12} /> Email address</label>
          <input className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-indigo-500/60" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required />
        </div>
        <div className="space-y-2">
          <label className="text-[10px] uppercase tracking-widest text-gray-500 ml-3 flex items-center gap-2"><Lock size={12} /> Password</label>
          <input className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-indigo-500/60" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        {error && <p role="alert" className="text-xs text-red-400 bg-red-500/10 rounded-xl p-3">{error}</p>}
        {message && <p role="status" className="text-xs text-emerald-400 bg-emerald-500/10 rounded-xl p-3">{message}</p>}
        <button disabled={loading} type="submit" className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-2xl text-white font-bold uppercase tracking-widest text-xs">{loading ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" disabled={loading || !email.trim()} onClick={() => void run(async () => { await onResetPassword(email); setMessage('If the address is registered, Firebase will send a password reset email.'); })} className="w-full text-xs text-gray-400 hover:text-white disabled:opacity-40">Forgot your password?</button>
      </motion.form>
    </div>
  );
};
