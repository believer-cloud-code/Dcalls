import React, { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Mail, User as UserIcon, AtSign, Lock, ChevronLeft } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import { auth } from '../firebase';
import type { NewAccountData } from '../services/authService';

interface RegistrationScreenProps {
  onComplete: (data: NewAccountData) => Promise<void>;
  onBack?: () => void;
  isExistingUser?: boolean;
}

export const RegistrationScreen: React.FC<RegistrationScreenProps> = ({
  onComplete,
  onBack,
  isExistingUser = false,
}) => {
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState(auth.currentUser?.email || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [about, setAbout] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const needsEmailPassword = !auth.currentUser?.email;
  const displayName = [firstName.trim(), middleName.trim(), lastName.trim()]
    .filter(Boolean)
    .join(' ');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (!firstName.trim() || !lastName.trim() || !username.trim() || !email.trim()) {
      setError('Please complete all required fields.');
      return;
    }
    if (needsEmailPassword && password.length < 6) {
      setError('Your password must contain at least 6 characters.');
      return;
    }
    if (needsEmailPassword && password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await onComplete({
        firstName: firstName.trim(),
        middleName: middleName.trim(),
        lastName: lastName.trim(),
        displayName,
        username: username.trim().replace(/^@/, ''),
        email: email.trim(),
        password: needsEmailPassword ? password : undefined,
        about: about.trim(),
        photoURL: auth.currentUser?.photoURL ?? null,
      });
    } catch (submitError: any) {
      setError(submitError?.message || 'Could not complete registration. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const fieldClass = 'w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4 text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-500/60 transition-colors';

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] z-[300] flex flex-col items-center justify-center p-6 text-center overflow-y-auto">
      <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/5 via-transparent to-purple-500/5 pointer-events-none" />
      {onBack && (
        <button onClick={onBack} className="absolute top-8 left-6 p-2 hover:bg-white/5 rounded-full z-[310]" aria-label="Go back">
          <ChevronLeft size={24} className="text-gray-400" />
        </button>
      )}

      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full max-w-md space-y-6 relative z-10 py-10">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] font-bold uppercase tracking-[0.2em]">
            <DcallsIcon size={12} /> Setup Profile
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-white">
            {isExistingUser ? 'Complete your Dcalls profile' : 'Create your Dcalls account'}
          </h2>
          <p className="text-gray-400 text-sm">
            Use a unique username so friends can find you without a phone number.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-left">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2">First name *</label>
              <input className={fieldClass} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First name" autoComplete="given-name" required />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2">Last name *</label>
              <input className={fieldClass} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last name" autoComplete="family-name" required />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2">Middle / other names (optional)</label>
            <input className={fieldClass} value={middleName} onChange={e => setMiddleName(e.target.value)} placeholder="Middle or other names" autoComplete="additional-name" />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2 flex items-center gap-2"><AtSign size={12} /> Username *</label>
            <input className={fieldClass} value={username} onChange={e => setUsername(e.target.value.replace(/\s/g, '').replace(/^@/, ''))} placeholder="e.g. john256" autoComplete="username" maxLength={20} required />
            <p className="text-[10px] text-gray-500 mt-2 ml-2">3–20 characters: letters, numbers and underscores. Usernames are case-insensitive.</p>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2 flex items-center gap-2"><Mail size={12} /> Email address *</label>
            <input className={fieldClass} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required readOnly={isExistingUser && !!auth.currentUser?.email} />
            <p className="text-[10px] text-gray-500 mt-2 ml-2">Your email is used for sign-in and recovery, not for finding contacts.</p>
          </div>

          {needsEmailPassword && (
            <>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2 flex items-center gap-2"><Lock size={12} /> Password *</label>
                <input className={fieldClass} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" required />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2">Confirm password *</label>
                <input className={fieldClass} type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Enter password again" autoComplete="new-password" required />
              </div>
            </>
          )}

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2">About me (optional)</label>
            <textarea className={fieldClass} value={about} onChange={e => setAbout(e.target.value)} placeholder="A little about yourself" rows={3} maxLength={160} />
          </div>

          {error && <p role="alert" className="text-red-400 text-xs font-medium bg-red-500/10 border border-red-500/20 rounded-xl p-3">{error}</p>}

          <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-3 py-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-2xl font-bold uppercase tracking-widest text-xs shadow-xl shadow-indigo-600/20 transition-all">
            {loading ? 'Please wait…' : isExistingUser ? 'Save profile' : 'Create account'}
            <ArrowRight size={18} />
          </button>
        </form>
      </motion.div>
    </div>
  );
};
