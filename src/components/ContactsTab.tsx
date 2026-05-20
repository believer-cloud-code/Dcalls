import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Phone, Video, Search, UserPlus, MoreVertical, User, MessageSquare, RefreshCw, Check, ShieldCheck, Trash2, AlertTriangle, X } from 'lucide-react';
import { collection, onSnapshot, query, orderBy, getDocs, where, addDoc, serverTimestamp, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Contact } from '../types';
import { lookupUidByPhone } from '../services/contactService';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ContactsTabProps {
  onCall: (contact: Contact, type: 'voice' | 'video') => void;
  onMessage: (contact: Contact) => void;
  onAddContact: () => void;
  searchQuery: string;
}

export const ContactsTab: React.FC<ContactsTabProps> = ({ onCall, onMessage, onAddContact, searchQuery }) => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);
  const [contactToDelete, setContactToDelete] = useState<Contact | null>(null);
  const [deletingContact, setDeletingContact] = useState(false);

  useEffect(() => {
    if (!auth.currentUser) return;

    const contactsRef = collection(db, 'users', auth.currentUser.uid, 'contacts');
    const q = query(contactsRef, orderBy('displayName', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const contactData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Contact[];
      setContacts(contactData);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching contacts:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Backfill uid for legacy contacts saved before uid was stored
  useEffect(() => {
    if (!auth.currentUser) return;
    const backfill = async () => {
      for (const contact of contacts) {
        if (contact.uid || !contact.phoneNumber) continue;
        const uid = await lookupUidByPhone(contact.phoneNumber);
        if (uid) {
          await updateDoc(doc(db, 'users', auth.currentUser!.uid, 'contacts', contact.id), { uid });
        }
      }
    };
    if (contacts.some(c => !c.uid && c.phoneNumber)) {
      void backfill();
    }
  }, [contacts]);

  const handleSyncContacts = async () => {
    if (!auth.currentUser) return;
    setSyncing(true);
    
    // Mock local contacts phone numbers
    const mockLocalPhones = [
      '+15550101', '+15550102', '+15550103', '+15550104', '+15550105'
    ];

    try {
      const usersRef = collection(db, 'users');
      const contactsRef = collection(db, 'users', auth.currentUser.uid, 'contacts');
      
      let foundCount = 0;
      for (const phone of mockLocalPhones) {
        // Check if user exists in dCalls
        const q = query(usersRef, where('phoneNumber', '==', phone));
        const snapshot = await getDocs(q);
        
        if (!snapshot.empty) {
          const userDoc = snapshot.docs[0];
          const userData = userDoc.data();
          
          // Check if already in contacts
          const existingQ = query(contactsRef, where('phoneNumber', '==', phone));
          const existingSnapshot = await getDocs(existingQ);
          
          if (existingSnapshot.empty) {
            await addDoc(contactsRef, {
              ownerId: auth.currentUser.uid,
              uid: userDoc.id,
              phoneNumber: phone,
              displayName: userData.displayName,
              photoURL: userData.photoURL || null,
              createdAt: serverTimestamp(),
            });
            foundCount++;
          }
        }
      }
      
      setSyncSuccess(true);
      setTimeout(() => setSyncSuccess(false), 3000);
    } catch (error) {
      console.error("Sync failed", error);
    } finally {
      setSyncing(false);
    }
  };

  const filteredContacts = contacts.filter(c => 
    c.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.phoneNumber.includes(searchQuery)
  );

  const handleDeleteContact = async (contact: Contact) => {
    if (!auth.currentUser) return;
    setDeletingContact(true);
    try {
      await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'contacts', contact.id));
      setContactToDelete(null);
    } catch (error) {
      console.error("Error deleting contact:", error);
    } finally {
      setDeletingContact(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* Sync Banner */}
      <div className="px-4 py-3 bg-indigo-600/10 border-b border-indigo-500/20 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center text-indigo-400">
            <ShieldCheck size={18} />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-white uppercase tracking-widest">Identity Sync</span>
            <span className="text-[9px] text-gray-500">Connect with your verified contacts</span>
          </div>
        </div>
        <button 
          onClick={handleSyncContacts}
          disabled={syncing}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${
            syncSuccess ? 'bg-emerald-500 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-500'
          }`}
        >
          {syncing ? <RefreshCw size={12} className="animate-spin" /> : syncSuccess ? <Check size={12} /> : <RefreshCw size={12} />}
          {syncing ? 'Syncing...' : syncSuccess ? 'Synced' : 'Sync Now'}
        </button>
      </div>

      {/* Contacts List */}
      <div className="flex-1 overflow-y-auto px-2 pt-4">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center text-gray-600">
              <User size={32} />
            </div>
            <div className="space-y-1">
              <p className="text-gray-400 font-medium">No contacts found</p>
              <button 
                onClick={onAddContact}
                className="text-indigo-400 text-sm font-bold hover:underline"
              >
                Add your first contact
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {filteredContacts.map((contact) => (
              <motion.div
                key={contact.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-4 p-3 rounded-2xl hover:bg-white/5 transition-colors group"
              >
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-white/5 flex items-center justify-center text-indigo-400 font-bold text-lg">
                  {contact.photoURL ? (
                    <img src={contact.photoURL} alt="" className="w-full h-full object-cover rounded-2xl" />
                  ) : (
                    contact.displayName.charAt(0).toUpperCase()
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <h4 className="text-white font-semibold truncate">{contact.displayName}</h4>
                  <p className="text-gray-500 text-xs truncate">{contact.phoneNumber}</p>
                </div>

                <div className="flex items-center gap-1">
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      onMessage(contact);
                    }}
                    className="p-2.5 text-gray-400 hover:text-indigo-400 hover:bg-indigo-400/10 rounded-xl transition-all"
                  >
                    <MessageSquare size={20} />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      onCall(contact, 'voice');
                    }}
                    className="p-2.5 text-gray-400 hover:text-emerald-400 hover:bg-emerald-400/10 rounded-xl transition-all"
                  >
                    <Phone size={20} />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      onCall(contact, 'video');
                    }}
                    className="p-2.5 text-gray-400 hover:text-indigo-400 hover:bg-indigo-400/10 rounded-xl transition-all"
                  >
                    <Video size={20} />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setContactToDelete(contact);
                    }}
                    className="p-2.5 text-gray-600 hover:text-red-400 hover:bg-red-400/10 rounded-xl transition-all"
                    title="Delete contact"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Delete Contact Confirmation Modal */}
      <AnimatePresence>
        {contactToDelete && (
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
                  <h3 className="text-xl font-bold text-white">Delete Contact?</h3>
                  <p className="text-sm text-gray-400">
                    Are you sure you want to delete <span className="font-semibold text-white">{contactToDelete.displayName}</span>? This action cannot be undone.
                  </p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <button
                  onClick={() => setContactToDelete(null)}
                  className="flex-1 py-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white text-sm font-bold transition-all active:scale-95"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteContact(contactToDelete)}
                  disabled={deletingContact}
                  className="flex-1 py-3 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-2xl text-white text-sm font-bold transition-all active:scale-95 shadow-lg shadow-red-600/20"
                >
                  {deletingContact ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
