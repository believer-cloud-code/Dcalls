import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Phone, Video, User, MessageSquare, Trash2, AlertTriangle } from 'lucide-react';
import { collection, onSnapshot, query, orderBy, deleteDoc, doc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Contact } from '../types';

interface ContactsTabProps {
  onCall: (contact: Contact, type: 'voice' | 'video') => void;
  onMessage: (contact: Contact) => void;
  onAddContact: () => void;
  searchQuery: string;
}

export const ContactsTab: React.FC<ContactsTabProps> = ({ onCall, onMessage, onAddContact, searchQuery }) => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [contactToDelete, setContactToDelete] = useState<Contact | null>(null);
  const [deletingContact, setDeletingContact] = useState(false);

  useEffect(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) { setLoading(false); return; }
    const contactsRef = collection(db, 'users', currentUser.uid, 'contacts');
    const unsubscribe = onSnapshot(query(contactsRef, orderBy('displayName', 'asc')), snapshot => {
      setContacts(snapshot.docs.map(item => ({ id: item.id, ...item.data() })) as Contact[]);
      setLoading(false);
    }, error => {
      console.error('Error fetching contacts:', error);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const filteredContacts = contacts.filter(contact => {
    const localName = contact.customName || contact.displayName || '';
    const username = contact.username || '';
    const term = searchQuery.toLowerCase();
    return localName.toLowerCase().includes(term) || username.toLowerCase().includes(term);
  });

  const handleDeleteContact = async (contact: Contact) => {
    if (!auth.currentUser) return;
    setDeletingContact(true);
    try {
      await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'contacts', contact.id));
      setContactToDelete(null);
    } catch (error) {
      console.error('Error deleting contact:', error);
    } finally {
      setDeletingContact(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <div><p className="text-xs font-bold text-white">Your contacts</p><p className="text-[10px] text-gray-500">Contact names are private to your account</p></div>
        <button onClick={onAddContact} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold">Add contact</button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pt-4">
        {loading ? (
          <div className="flex items-center justify-center py-10"><div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" /></div>
        ) : filteredContacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center text-gray-600"><User size={32} /></div>
            <div className="space-y-1"><p className="text-gray-400 font-medium">No contacts found</p><button onClick={onAddContact} className="text-indigo-400 text-sm font-bold hover:underline">Add your first contact</button></div>
          </div>
        ) : (
          <div className="space-y-1">
            {filteredContacts.map(contact => {
              const localName = contact.customName || contact.displayName || 'Dcalls contact';
              return (
                <motion.div key={contact.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 p-3 rounded-2xl hover:bg-white/5 transition-colors">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-white/5 flex items-center justify-center text-indigo-400 font-bold text-lg overflow-hidden">
                    {contact.photoURL ? <img src={contact.photoURL} alt="" className="w-full h-full object-cover" /> : localName.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0"><h4 className="text-white font-semibold truncate">{localName}</h4><p className="text-gray-500 text-xs truncate">@{contact.username || 'legacy contact'}</p></div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => onMessage(contact)} className="p-2.5 text-gray-400 hover:text-indigo-400 rounded-xl" aria-label="Message"><MessageSquare size={20} /></button>
                    <button onClick={() => onCall(contact, 'voice')} className="p-2.5 text-gray-400 hover:text-emerald-400 rounded-xl" aria-label="Voice call"><Phone size={20} /></button>
                    <button onClick={() => onCall(contact, 'video')} className="p-2.5 text-gray-400 hover:text-indigo-400 rounded-xl" aria-label="Video call"><Video size={20} /></button>
                    <button onClick={() => setContactToDelete(contact)} className="p-2.5 text-gray-600 hover:text-red-400 rounded-xl" title="Delete contact"><Trash2 size={20} /></button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
      <AnimatePresence>
        {contactToDelete && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[500] flex items-center justify-center p-6">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="w-full max-w-sm bg-[#1a1a1a] border border-white/10 rounded-3xl p-6 space-y-6 shadow-2xl">
              <div className="flex flex-col items-center text-center space-y-4"><div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center text-red-500"><AlertTriangle size={32} /></div><div className="space-y-2"><h3 className="text-xl font-bold text-white">Delete contact?</h3><p className="text-sm text-gray-400">Remove <span className="font-semibold text-white">{contactToDelete.customName || contactToDelete.displayName}</span> from your contacts?</p></div></div>
              <div className="flex gap-3"><button onClick={() => setContactToDelete(null)} className="flex-1 py-3 bg-white/5 rounded-2xl text-white text-sm font-bold">Cancel</button><button onClick={() => handleDeleteContact(contactToDelete)} disabled={deletingContact} className="flex-1 py-3 bg-red-600 disabled:opacity-50 rounded-2xl text-white text-sm font-bold">{deletingContact ? 'Deleting…' : 'Delete'}</button></div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
