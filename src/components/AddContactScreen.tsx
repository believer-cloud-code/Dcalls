import React, { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, UserPlus, AtSign, Search, RefreshCw, Check } from 'lucide-react';
import { collection, addDoc, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { lookupUserByUsername } from '../services/contactService';

interface AddContactScreenProps {
  onBack: () => void;
}

export const AddContactScreen: React.FC<AddContactScreenProps> = ({ onBack }) => {
  const [username, setUsername] = useState('');
  const [customName, setCustomName] = useState('');
  const [foundUser, setFoundUser] = useState<Awaited<ReturnType<typeof lookupUserByUsername>>>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleLookup = async () => {
    setSearching(true);
    setError('');
    setFoundUser(null);
    try {
      const result = await lookupUserByUsername(username);
      if (!result) setError('No Dcalls account was found with that username.');
      else setFoundUser(result);
    } catch (err: any) {
      setError(err?.message || 'Could not search for that username.');
    } finally {
      setSearching(false);
    }
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!auth.currentUser || !foundUser || !customName.trim()) return;
    setLoading(true);
    setError('');
    try {
      const contactsRef = collection(db, 'users', auth.currentUser.uid, 'contacts');
      const existing = await getDocs(query(contactsRef, where('uid', '==', foundUser.uid)));
      if (!existing.empty) {
        setError('This person is already in your contacts.');
        return;
      }
      await addDoc(contactsRef, {
        ownerId: auth.currentUser.uid,
        uid: foundUser.uid,
        username: foundUser.username,
        customName: customName.trim(),
        displayName: customName.trim(),
        photoURL: foundUser.photoURL ?? null,
        createdAt: serverTimestamp(),
      });
      setSuccess(true);
      setTimeout(onBack, 900);
    } catch (err: any) {
      setError(err?.message || 'Could not save this contact.');
    } finally {
      setLoading(false);
    }
  };

  const fieldClass = 'w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4 text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-500/60';

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] z-[300] flex flex-col">
      <header className="flex items-center gap-4 px-4 py-4 bg-[#121212] border-b border-white/5">
        <button onClick={onBack} className="p-2 text-gray-400 hover:text-white" aria-label="Go back"><ArrowLeft size={20} /></button>
        <h3 className="font-semibold text-lg flex-1">Add Contact</h3>
      </header>
      <div className="flex-1 overflow-y-auto p-6 flex items-start justify-center">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md space-y-7">
          <div className="text-center space-y-3">
            <div className="w-20 h-20 rounded-[2rem] bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400"><UserPlus size={32} /></div>
            <h2 className="text-xl font-bold text-white">Find someone on Dcalls</h2>
            <p className="text-sm text-gray-400">Search using their unique username. Their email and phone number are not needed.</p>
          </div>
          <div className="space-y-3">
            <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500 ml-3 flex items-center gap-2"><AtSign size={12} /> Dcalls username</label>
            <div className="flex gap-2">
              <input className={fieldClass} value={username} onChange={e => { setUsername(e.target.value); setFoundUser(null); }} placeholder="john256" onKeyDown={e => e.key === 'Enter' && void handleLookup()} />
              <button type="button" onClick={handleLookup} disabled={searching || !username.trim()} className="px-4 rounded-2xl bg-indigo-600 text-white disabled:opacity-50">{searching ? <RefreshCw className="animate-spin" size={18} /> : <Search size={18} />}</button>
            </div>
          </div>
          {foundUser && (
            <form onSubmit={handleAdd} className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-indigo-500/20 overflow-hidden flex items-center justify-center text-white font-bold">
                  {foundUser.photoURL ? <img src={foundUser.photoURL} alt="" className="w-full h-full object-cover" /> : foundUser.displayName.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0"><p className="font-semibold text-white truncate">{foundUser.displayName}</p><p className="text-xs text-gray-400">@{foundUser.username}</p></div>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 ml-2">Save contact as (private to you)</label>
                <input className={fieldClass} value={customName} onChange={e => setCustomName(e.target.value)} placeholder="e.g. John (School)" required />
              </div>
              <button type="submit" disabled={loading || !customName.trim() || success} className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-indigo-600 text-white font-bold text-xs uppercase tracking-widest disabled:opacity-50">
                {success ? <><Check size={18} /> Contact added</> : loading ? 'Saving…' : 'Save contact'}
              </button>
            </form>
          )}
          {error && <p role="alert" className="text-xs text-red-400 bg-red-500/10 rounded-xl p-3">{error}</p>}
        </motion.div>
      </div>
    </div>
  );
};
