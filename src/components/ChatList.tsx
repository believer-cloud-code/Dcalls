import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { Chat, Contact } from '../types';
import { doc, getDoc, collection, onSnapshot, query, orderBy, deleteDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { MessageSquare, Trash2, AlertTriangle, X } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ChatListProps {
  chats: Chat[];
  onChatClick: (chatId: string) => void;
  onStartChat?: (contact: Contact) => void;
}

export const ChatList: React.FC<ChatListProps> = ({ chats, onChatClick, onStartChat }) => {
  const [participantNames, setParticipantNames] = useState<Record<string, string>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactToDelete, setContactToDelete] = useState<Contact | null>(null);
  const [deletingContact, setDeletingContact] = useState(false);

  useEffect(() => {
    const fetchNames = async () => {
      const newNames: Record<string, string> = { ...participantNames };
      let changed = false;

      for (const chat of chats) {
        const otherId = chat.participants.find(p => p !== auth.currentUser?.uid);
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

    if (chats.length > 0) {
      fetchNames();
    }
  }, [chats]);

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
    }, (error) => {
      console.error("Error fetching contacts:", error);
    });

    return () => unsubscribe();
  }, []);

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

  if (chats.length === 0 && contacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-4 p-8 text-center">
        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center">
          <span className="text-2xl">💬</span>
        </div>
        <p className="text-sm">No chats or contacts. Start by adding a contact or messaging someone.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col pt-2 pb-20">
      {/* Chats Section */}
      {chats.length > 0 && (
        <>
          <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-gray-600">Messages</div>
          {chats.map((chat, index) => {
            const otherId = chat.participants.find(p => p !== auth.currentUser?.uid);
            const chatName = chat.type === 'group' ? 'Team Project' : (otherId ? participantNames[otherId] || 'Loading...' : 'User');

            return (
              <motion.button
                key={chat.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => onChatClick(chat.id)}
                className="flex items-center gap-4 p-4 hover:bg-white/5 active:bg-white/10 transition-colors border-b border-white/5 text-left w-full"
              >
                <div className="relative">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center text-xl font-bold overflow-hidden border border-white/10">
                    {chat.type === 'group' ? '👥' : chatName.charAt(0).toUpperCase()}
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 border-2 border-[#0a0a0a] rounded-full" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline mb-1">
                    <h3 className="font-medium text-white truncate">
                      {chatName}
                    </h3>
                    <span className="text-[10px] text-gray-500 uppercase tracking-tighter">
                      {chat.lastMessageTime ? format(chat.lastMessageTime.toDate(), 'HH:mm') : ''}
                    </span>
                  </div>
                  <p className="text-sm text-gray-400 truncate leading-tight">
                    {chat.lastMessage || 'No messages yet'}
                  </p>
                </div>
              </motion.button>
            );
          })}
        </>
      )}

      {/* Contacts Section */}
      {contacts.length > 0 && (
        <>
          <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-gray-600 mt-2">Quick Contacts</div>
          {contacts.map((contact, index) => (
            <motion.button
              key={contact.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              onClick={() => onStartChat?.(contact)}
              className="w-full flex items-center gap-4 p-4 hover:bg-white/5 active:bg-white/10 transition-colors border-b border-white/5 group text-left"
            >
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center text-xl font-bold overflow-hidden border border-white/10">
                {contact.photoURL ? (
                  <img src={contact.photoURL} alt="" className="w-full h-full object-cover" />
                ) : (
                  contact.displayName.charAt(0).toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline mb-1">
                  <h3 className="font-medium text-white truncate">
                    {contact.displayName}
                  </h3>
                  <span className="text-[10px] text-gray-500 uppercase tracking-tighter">Contact</span>
                </div>
                <p className="text-sm text-gray-400 truncate leading-tight">
                  {contact.phoneNumber}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setContactToDelete(contact);
                }}
                className="p-2 text-gray-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                title="Delete contact"
              >
                <Trash2 size={18} />
              </button>
            </motion.button>
          ))}
        </>
      )}

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
