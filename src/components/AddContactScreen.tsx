import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, UserPlus, Search, Check, Globe, Phone as PhoneIcon, User as UserIcon, RefreshCw } from 'lucide-react';
import PhoneInput from 'react-phone-input-2';
import 'react-phone-input-2/lib/style.css';
import { collection, addDoc, serverTimestamp, query, where, getDocs, limit } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { normalizePhone, resolveContactByPhone } from '../services/contactService';

interface AddContactScreenProps {
  onBack: () => void;
}

export const AddContactScreen: React.FC<AddContactScreenProps> = ({ onBack }) => {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<'manual' | 'discover'>('manual');
  
  // Discovery states
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  const handleAdd = async (e: React.FormEvent | null, manualData?: { phone: string, name: string, uid?: string, photoURL?: string | null }) => {
    if (e) e.preventDefault();
    const phone = manualData?.phone || phoneNumber;
    const name = manualData?.name || displayName;
    
    if (!auth.currentUser || !phone || !name.trim()) return;

    setLoading(true);
    try {
      const formattedPhone = normalizePhone(phone);
      let uid = manualData?.uid;
      let photoURL = manualData?.photoURL ?? null;

      if (!uid) {
        const resolved = await resolveContactByPhone(formattedPhone);
        if (resolved?.uid) {
          uid = resolved.uid;
          photoURL = resolved.photoURL ?? photoURL;
        }
      }

      const contactsRef = collection(db, 'users', auth.currentUser.uid, 'contacts');
      await addDoc(contactsRef, {
        ownerId: auth.currentUser.uid,
        phoneNumber: formattedPhone,
        displayName: name.trim(),
        ...(uid ? { uid } : {}),
        ...(photoURL ? { photoURL } : {}),
        createdAt: serverTimestamp(),
      });
      setSuccess(true);
      setTimeout(onBack, 1500);
    } catch (error) {
      console.error("Failed to add contact", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const usersRef = collection(db, 'users');
      // Search by phone number (exact match)
      const q = query(
        usersRef, 
        where('phoneNumber', '==', searchQuery.startsWith('+') ? searchQuery : '+' + searchQuery),
        limit(5)
      );
      const snapshot = await getDocs(q);
      const results = snapshot.docs.map(docSnap => ({
        uid: docSnap.id,
        ...docSnap.data(),
      }));
      setSearchResults(results);
    } catch (error) {
      console.error("Search failed", error);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] z-[300] flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-4 px-4 py-4 bg-[#121212] border-b border-white/5">
        <button 
          onClick={onBack} 
          className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-400 hover:text-white flex items-center gap-2"
          title="Go back"
        >
          <ArrowLeft size={20} />
        </button>
        <h3 className="font-semibold text-lg flex-1">Add Contact</h3>
      </header>

      {/* Tabs */}
      <div className="flex p-2 bg-[#121212] border-b border-white/5">
        <button 
          onClick={() => setActiveTab('manual')}
          className={`flex-1 py-2 text-xs font-bold uppercase tracking-widest rounded-xl transition-all ${activeTab === 'manual' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}
        >
          Manual Entry
        </button>
        <button 
          onClick={() => setActiveTab('discover')}
          className={`flex-1 py-2 text-xs font-bold uppercase tracking-widest rounded-xl transition-all ${activeTab === 'discover' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}
        >
          Discover Users
        </button>
      </div>

      <div className="flex-1 p-6 space-y-8 overflow-y-auto">
        <AnimatePresence mode="wait">
          {activeTab === 'manual' ? (
            <motion.div 
              key="manual"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="space-y-8"
            >
              <div className="text-center space-y-2">
                <div className="w-20 h-20 rounded-[2rem] bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400">
                  <UserPlus size={32} />
                </div>
                <p className="text-gray-400 text-sm max-w-[250px] mx-auto">
                  Add a contact by entering their phone number and a name.
                </p>
              </div>

              <form onSubmit={(e) => handleAdd(e)} className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500 ml-4">Phone Number</label>
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

                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500 ml-4">Contact Name</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Sarah Wilson"
                    required
                    className="w-full bg-white/5 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || !phoneNumber || !displayName.trim() || success}
                  className={`w-full flex items-center justify-center gap-3 py-4 rounded-2xl font-bold uppercase tracking-widest text-xs transition-all active:scale-95 shadow-xl ${
                    success 
                      ? "bg-emerald-500 text-white shadow-emerald-500/20" 
                      : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20 disabled:opacity-50"
                  }`}
                >
                  {success ? (
                    <>
                      <Check size={18} />
                      Contact Added
                    </>
                  ) : loading ? (
                    "Adding..."
                  ) : (
                    "Save Contact"
                  )}
                </button>
              </form>
            </motion.div>
          ) : (
            <motion.div 
              key="discover"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="text-center space-y-2">
                <div className="w-20 h-20 rounded-[2rem] bg-purple-500/10 border border-purple-500/20 flex items-center justify-center mx-auto text-purple-400">
                  <Globe size={32} />
                </div>
                <p className="text-gray-400 text-sm max-w-[250px] mx-auto">
                  Find other dCalls users by their verified phone number.
                </p>
              </div>

              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="Enter phone number (e.g. +1234567890)"
                  className="w-full bg-white/5 border border-white/5 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                />
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" size={20} />
                <button 
                  onClick={handleSearch}
                  disabled={searching || !searchQuery.trim()}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-purple-600 rounded-xl text-white disabled:opacity-50"
                >
                  {searching ? <RefreshCw size={16} className="animate-spin" /> : <ArrowLeft className="rotate-180" size={16} />}
                </button>
              </div>

              <div className="space-y-3">
                {searchResults.length > 0 ? (
                  searchResults.map((user) => (
                    <div key={user.uid} className="flex items-center gap-4 p-4 bg-white/5 rounded-2xl border border-white/5">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-bold">
                        {user.photoURL ? <img src={user.photoURL} className="w-full h-full object-cover rounded-xl" /> : user.displayName[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-white font-semibold truncate">{user.displayName}</h4>
                        <p className="text-gray-500 text-xs truncate">{user.phoneNumber}</p>
                      </div>
                      <button 
                        onClick={() => handleAdd(null, {
                          phone: user.phoneNumber,
                          name: user.displayName,
                          uid: user.uid,
                          photoURL: user.photoURL,
                        })}
                        disabled={loading || success}
                        className="p-3 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-all"
                      >
                        <UserPlus size={20} />
                      </button>
                    </div>
                  ))
                ) : searchQuery && !searching && (
                  <p className="text-center text-gray-500 text-sm py-10">No users found with this phone number.</p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

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
