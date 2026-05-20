import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { doc, getDoc, collection, onSnapshot, query, where, orderBy, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { lookupUidByPhone } from '../services/contactService';
import { ChatList } from './ChatList';
import { ChatInterface } from './ChatInterface';
import { Contact, Chat } from '../types';

interface ChatScreenProps {
    searchQuery: string;
}

export const ChatScreen: React.FC<ChatScreenProps> = ({ searchQuery }) => {
    const [chats, setChats] = useState<Chat[]>([]);
    const [activeChat, setActiveChat] = useState<string | null>(null);
    const [activeChatPartner, setActiveChatPartner] = useState<Contact | null>(null);

    // Fetch chats for current user
    useEffect(() => {
        if (!auth.currentUser || !auth.currentUser.uid) return;

        const chatsRef = collection(db, 'chats');
        const chatsQuery = query(
            chatsRef,
            where('participants', 'array-contains', auth.currentUser.uid),
            orderBy('lastMessageTime', 'desc')
        );

        const unsubscribe = onSnapshot(chatsQuery, (snapshot) => {
            const chatData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            })) as Chat[];
            setChats(chatData);
        });

        return () => unsubscribe();
    }, []);

    const handleChatClick = async (chatId: string) => {
        setActiveChat(chatId);

        // Fetch the chat partner info
        const chat = chats.find(c => c.id === chatId);
        if (chat) {
            const partnerId = chat.participants.find(p => p !== auth.currentUser?.uid);
            if (partnerId) {
                const userDoc = await getDoc(doc(db, 'users', partnerId));
                if (userDoc.exists()) {
                    const userData = userDoc.data();
                    setActiveChatPartner({
                        id: partnerId,
                        uid: partnerId,
                        ownerId: auth.currentUser?.uid || '',
                        displayName: userData.displayName || 'User',
                        photoURL: userData.photoURL,
                        phoneNumber: userData.phoneNumber,
                        status: userData.status
                    } as Contact);
                }
            }
        }
    };

    const handleStartChat = async (contact: Contact) => {
        if (!auth.currentUser) return;

        let partnerUid = contact.uid;
        if (!partnerUid && contact.phoneNumber) {
            partnerUid = (await lookupUidByPhone(contact.phoneNumber)) ?? undefined;
        }
        if (!partnerUid) return;

        let chatId: string | null = null;

        // Check if chat already exists

        const existingChat = chats.find(
            chat => chat.participants.includes(partnerUid) &&
                chat.participants.includes(auth.currentUser?.uid || '')
        );

        if (existingChat) {
            chatId = existingChat.id;
        }

        if (chatId) {
            setActiveChat(chatId);
            setActiveChatPartner(contact);
        }
    };

    const handleBackToList = () => {
        setActiveChat(null);
        setActiveChatPartner(null);
    };

    return (
        <div className="w-full h-full relative">
            <AnimatePresence mode="wait">
                {activeChat ? (
                    // Chat Interface View
                    <motion.div
                        key="chat-interface"
                        initial={{ opacity: 0, x: 300 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 300 }}
                        transition={{ duration: 0.3 }}
                        className="absolute inset-0"
                    >
                        <ChatInterface
                            chatId={activeChat}
                            onBack={handleBackToList}
                            contactName={activeChatPartner?.displayName}
                            contactPhoto={activeChatPartner?.photoURL}
                            contactId={activeChatPartner?.uid || activeChatPartner?.id}
                        />
                    </motion.div>
                ) : (
                    // Chat List View
                    <motion.div
                        key="chat-list"
                        initial={{ opacity: 0, x: -300 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -300 }}
                        transition={{ duration: 0.3 }}
                        className="absolute inset-0 overflow-y-auto"
                    >
                        <ChatList
                            chats={chats}
                            onChatClick={handleChatClick}
                            onStartChat={handleStartChat}
                        />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
