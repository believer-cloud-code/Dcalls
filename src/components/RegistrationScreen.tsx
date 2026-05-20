import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Camera, ArrowRight, Phone, Mail, User as UserIcon, Lock, ChevronLeft } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import PhoneInput from 'react-phone-input-2';
import 'react-phone-input-2/lib/style.css';
import { auth } from '../firebase';

interface RegistrationData {
  displayName: string;
  email: string;
  phoneNumber: string;
  password: string;
}

interface RegistrationScreenProps {
  onComplete: (data: RegistrationData) => void;
  onBack?: () => void;
}

export const RegistrationScreen: React.FC<RegistrationScreenProps> = ({ onComplete, onBack }) => {
  const [displayName, setDisplayName] = useState(auth.currentUser?.displayName || '');
  const [email, setEmail] = useState(auth.currentUser?.email || '');
  const [phoneNumber, setPhoneNumber] = useState(auth.currentUser?.phoneNumber?.replace('+', '') || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || !phoneNumber.trim() || !password.trim()) return;

    onComplete({
      displayName: displayName.trim(),
      email: email.trim(),
      phoneNumber: '+' + phoneNumber,
      password: password.trim()
    });
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] z-[300] flex flex-col items-center justify-center p-6 text-center overflow-y-auto">
      <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/5 via-transparent to-purple-500/5 pointer-events-none" />
      
      {onBack && (
        <button 
          onClick={onBack}
          className="absolute top-8 left-6 p-2 hover:bg-white/5 rounded-full transition-colors z-[310]"
        >
          <ChevronLeft size={24} className="text-gray-400" />
        </button>
      )}
      <motion.div 
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="w-full max-w-md space-y-8 relative z-10 py-12"
      >
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] font-bold uppercase tracking-[0.2em] mb-4">
            <DcallsIcon size={12} />
            Setup Profile
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-white">Welcome to Dcalls</h2>
          <p className="text-gray-400 text-sm">Complete your profile to start messaging securely.</p>
        </div>

        <div className="relative group mx-auto w-28 h-28">
          <div className="w-full h-full rounded-[2.5rem] bg-gradient-to-br from-gray-800 to-gray-900 border border-white/10 flex items-center justify-center overflow-hidden shadow-2xl">
            {auth.currentUser?.photoURL ? (
              <img src={auth.currentUser.photoURL} alt="Profile" className="w-full h-full object-cover" />
            ) : (
              <UserIcon size={40} className="text-gray-600" />
            )}
          </div>
          <button className="absolute -bottom-1 -right-1 p-2.5 bg-indigo-600 rounded-2xl border-4 border-[#0a0a0a] text-white shadow-lg hover:scale-110 transition-transform">
            <Camera size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-1 gap-5">
            {/* Name Field */}
            <div className="space-y-1.5 text-left">
              <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500 ml-4 flex items-center gap-2">
                <UserIcon size={12} /> Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="John Doe"
                required
                className="w-full bg-white/5 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>

            {/* Email Field */}
            <div className="space-y-1.5 text-left">
              <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500 ml-4 flex items-center gap-2">
                <Mail size={12} /> Email Address (Optional)
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
                className="w-full bg-white/5 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>

            {/* Password Field */}
            <div className="space-y-1.5 text-left">
              <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500 ml-4 flex items-center gap-2">
                <Lock size={12} /> Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full bg-white/5 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>

            {/* Phone Field */}
            <div className="space-y-1.5 text-left">
              <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500 ml-4 flex items-center gap-2">
                <Phone size={12} /> Phone Number
              </label>
              <div className="phone-input-container">
                <PhoneInput
                  country={'us'}
                  value={phoneNumber}
                  onChange={setPhoneNumber}
                  containerClass="!bg-transparent"
                  inputClass="!w-full !bg-white/5 !border-white/5 !rounded-2xl !py-7 !px-14 !text-white !text-base focus:!border-indigo-500/50 !transition-colors"
                  buttonClass="!bg-transparent !border-white/5 !rounded-l-2xl !px-3 hover:!bg-white/5"
                  dropdownClass="!bg-[#1a1a1a] !text-white !border-white/10 !rounded-xl !shadow-2xl"
                  searchClass="!bg-[#0a0a0a] !text-white !border-white/10"
                  enableSearch={true}
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !displayName.trim() || !phoneNumber.trim() || !password.trim()}
            className="w-full flex items-center justify-center gap-3 py-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-2xl font-bold uppercase tracking-widest text-xs shadow-xl shadow-indigo-600/20 transition-all active:scale-95"
          >
            {loading ? "Processing..." : "Submit & Verify Phone"}
            {!loading && <ArrowRight size={18} />}
          </button>
        </form>
      </motion.div>

      <style>{`
        .phone-input-container .react-tel-input .form-control {
          width: 100% !important;
          height: 56px !important;
        }
        .phone-input-container .react-tel-input .flag-dropdown {
          background-color: transparent !important;
          border: none !important;
        }
        .phone-input-container .react-tel-input .selected-flag {
          background-color: transparent !important;
        }
        .phone-input-container .react-tel-input .country-list {
          background-color: #1a1a1a !important;
          color: white !important;
          border: 1px solid rgba(255, 255, 255, 0.1) !important;
        }
        .phone-input-container .react-tel-input .country-list .country:hover {
          background-color: rgba(255, 255, 255, 0.05) !important;
        }
        .phone-input-container .react-tel-input .country-list .country.highlight {
          background-color: rgba(139, 92, 246, 0.2) !important;
        }
      `}</style>
    </div>
  );
};
