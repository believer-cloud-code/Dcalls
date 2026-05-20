import React, { useState, useEffect } from 'react';
import { authService } from '../services/authService';
import { RecaptchaVerifier, ConfirmationResult } from 'firebase/auth';
import { auth } from '../firebase';
import { motion, AnimatePresence } from 'motion/react';
import { Phone, ArrowRight, ShieldCheck, RefreshCw, ChevronLeft } from 'lucide-react';
import PhoneInput from 'react-phone-input-2';
import 'react-phone-input-2/lib/style.css';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface PhoneAuthScreenProps {
  onSuccess: () => void;
  onBack: () => void;
  phoneNumber?: string;
}

export const PhoneAuthScreen: React.FC<PhoneAuthScreenProps> = ({ onSuccess, onBack, phoneNumber: initialPhoneNumber }) => {
  const [phoneNumber, setPhoneNumber] = useState(initialPhoneNumber?.replace('+', '') || '');
  const [verificationCode, setVerificationCode] = useState('');
  const [confirmationData, setConfirmationData] = useState<ConfirmationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [timer, setTimer] = useState(0);
  const recaptchaVerifierRef = React.useRef<RecaptchaVerifier | null>(null);

  useEffect(() => {
    if (initialPhoneNumber && !confirmationData && !loading) {
      handleSendCode();
    }
  }, [initialPhoneNumber]);

  useEffect(() => {
    let interval: any;
    if (timer > 0) {
      interval = setInterval(() => setTimer(prev => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [timer]);

  useEffect(() => {
    return () => {
      if (recaptchaVerifierRef.current) {
        recaptchaVerifierRef.current.clear();
        recaptchaVerifierRef.current = null;
      }
    };
  }, []);

  const initRecaptcha = () => {
    if (recaptchaVerifierRef.current) return recaptchaVerifierRef.current;

    try {
      const verifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        'size': 'invisible',
        'callback': () => {
          // reCAPTCHA solved
        },
        'expired-callback': () => {
          setError("reCAPTCHA expired. Please try again.");
          if (recaptchaVerifierRef.current) {
            recaptchaVerifierRef.current.clear();
            recaptchaVerifierRef.current = null;
          }
        }
      });
      recaptchaVerifierRef.current = verifier;
      return verifier;
    } catch (err: any) {
      console.error("Recaptcha init error:", err);
      return null;
    }
  };

  const handleSendCode = async () => {
    if (!phoneNumber) return;
    setLoading(true);
    setError('');
    try {
      const verifier = initRecaptcha();
      if (!verifier) throw new Error("Failed to initialize security check.");

      const formattedPhone = '+' + phoneNumber;
      const result = await authService.sendPhoneCode(formattedPhone, verifier);
      setConfirmationData(result);
      setTimer(60);
    } catch (err: any) {
      console.error("Phone auth error:", err);
      if (err.code === 'auth/network-request-failed') {
        setError("Network error. Please check your connection and try again.");
      } else if (err.message?.includes('rendered')) {
        // If it still says already rendered, try clearing and re-init
        if (recaptchaVerifierRef.current) {
          recaptchaVerifierRef.current.clear();
          recaptchaVerifierRef.current = null;
        }
        setError("Security check error. Please try clicking the button again.");
      } else {
        setError(err.message || "Failed to send code. Please try again.");
      }

      // Reset recaptcha container if it fails
      const container = document.getElementById('recaptcha-container');
      if (container) container.innerHTML = '';
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async () => {
    if (!verificationCode || !confirmationData) return;
    setLoading(true);
    setError('');
    try {
      await authService.verifyPhoneCode(verificationCode, confirmationData);
      onSuccess();
    } catch (err: any) {
      console.error("Verification error:", err);
      setError("Invalid code. Please check and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] z-[300] flex flex-col items-center justify-center p-6 text-center">
      <div id="recaptcha-container"></div>

      <button
        onClick={onBack}
        className="absolute top-8 left-6 p-2 hover:bg-white/5 rounded-full transition-colors"
      >
        <ChevronLeft size={24} className="text-gray-400" />
      </button>

      <div className="w-full max-w-md space-y-8">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-2xl shadow-indigo-500/20"
        >
          {confirmationData ? <ShieldCheck size={40} className="text-white" /> : <Phone size={40} className="text-white" />}
        </motion.div>

        <div className="space-y-2">
          <h2 className="text-3xl font-black tracking-tighter text-white">
            {confirmationData ? "Verify Code" : "Phone Identity"}
          </h2>
          <p className="text-gray-400 text-sm leading-relaxed">
            {confirmationData
              ? `We sent a 6-digit code to +${phoneNumber}`
              : "Verify your phone number to connect with your contacts securely."}
          </p>
        </div>

        <AnimatePresence mode="wait">
          {!confirmationData ? (
            <motion.div
              key="phone-input"
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              className="space-y-6"
            >
              <div className="phone-input-container">
                <PhoneInput
                  country={'us'}
                  value={phoneNumber}
                  onChange={setPhoneNumber}
                  containerClass="!w-full"
                  inputClass="!w-full !h-14 !bg-white/5 !border-white/10 !rounded-2xl !text-white !text-lg !pl-14"
                  buttonClass="!bg-transparent !border-white/10 !rounded-l-2xl !w-12"
                  dropdownClass="!bg-[#1a1a1a] !text-white !border-white/10"
                />
              </div>

              {error && <p className="text-red-500 text-xs font-bold">{error}</p>}

              <button
                disabled={loading || !phoneNumber}
                onClick={handleSendCode}
                className="w-full h-14 bg-white text-black rounded-2xl font-bold uppercase tracking-widest text-xs flex items-center justify-center gap-2 disabled:opacity-50 transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                {loading ? <RefreshCw size={18} className="animate-spin" /> : (
                  <>
                    Send Verification Code
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="code-input"
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              className="space-y-6"
            >
              <div className="flex justify-between gap-2">
                <input
                  type="text"
                  maxLength={6}
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full h-16 bg-white/5 border border-white/10 rounded-2xl text-center text-3xl font-black tracking-[0.5em] text-white focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>

              {error && <p className="text-red-500 text-xs font-bold">{error}</p>}

              <div className="space-y-4">
                <button
                  disabled={loading || verificationCode.length !== 6}
                  onClick={handleVerifyCode}
                  className="w-full h-14 bg-indigo-600 text-white rounded-2xl font-bold uppercase tracking-widest text-xs flex items-center justify-center gap-2 disabled:opacity-50 transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  {loading ? <RefreshCw size={18} className="animate-spin" /> : "Verify & Continue"}
                </button>

                <button
                  disabled={timer > 0}
                  onClick={handleSendCode}
                  className="text-xs font-bold text-gray-500 uppercase tracking-widest hover:text-white transition-colors disabled:opacity-50"
                >
                  {timer > 0 ? `Resend code in ${timer}s` : "Resend Code"}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="text-[10px] text-gray-600 font-bold uppercase tracking-[0.3em]">
          End-to-End Encrypted Identity
        </div>
      </div>

      <style>{`
        .phone-input-container .form-control {
          background: transparent !important;
          border: 1px solid rgba(255, 255, 255, 0.1) !important;
        }
        .phone-input-container .selected-flag {
          background: transparent !important;
        }
        .phone-input-container .country-list {
          background: #1a1a1a !important;
          border: 1px solid rgba(255, 255, 255, 0.1) !important;
        }
        .phone-input-container .country-list .country:hover {
          background: rgba(255, 255, 255, 0.05) !important;
        }
        .phone-input-container .country-list .country.highlight {
          background: rgba(99, 102, 241, 0.2) !important;
        }
      `}</style>
    </div>
  );
};
