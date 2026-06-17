/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { onAuthStateChanged, signInWithPopup, User } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, query, where, onSnapshot, orderBy, addDoc, serverTimestamp, limit, updateDoc } from 'firebase/firestore';
import { db, auth, googleProvider } from './firebase';
import { handleFirestoreError, OperationType } from './utils/firestoreErrorHandler';
import { databaseService } from './services/databaseService';
import { Layout } from './components/Layout';
import { ChatScreen } from './components/ChatScreen';
import { CallLog } from './components/CallLog';
import { DamaiTab } from './components/DamaiTab';
import { SettingsTab } from './components/SettingsTab';
import { CallingScreen } from './components/CallingScreen';
import { RegistrationScreen } from './components/RegistrationScreen';
import { PhoneAuthScreen } from './components/PhoneAuthScreen';
import { AddContactScreen } from './components/AddContactScreen';
import { ContactsTab } from './components/ContactsTab';
import { TabType, Chat, CallRecord, Contact } from './types';
import { LogIn, UserPlus, Phone, PhoneOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { authService, UnifiedUser } from './services/authService';
import { DcallsIcon } from './components/DcallsIcon';
import { lookupUidByPhone } from './services/contactService';
import { openMarketing } from './config/urls';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FeatureErrorBoundary } from './components/FeatureErrorBoundary';

export default function App() {
  const [user, setUser] = useState<UnifiedUser | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const [showPhoneAuth, setShowPhoneAuth] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('chats');
  const [activeCall, setActiveCall] = useState<{ type: 'voice' | 'video', contactName?: string, contactPhoto?: string, contactId?: string, incomingCallId?: string } | null>(null);
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [isAddingContact, setIsAddingContact] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [searchQuery, setSearchQuery] = useState('');
  const [chats, setChats] = useState<Chat[]>([]);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showRegistration, setShowRegistration] = useState(false);
  const [registrationData, setRegistrationData] = useState<any>(null);

  const loadUserProfile = async (uid: string) => {
    let isMounted = true;

    try {
      console.log("Loading user profile...");

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Profile timeout")), 5000)
      );

      const profilePromise = databaseService.getDocument(
        "users",
        uid
      );

      const result: any = await Promise.race([
        profilePromise,
        timeoutPromise,
      ]);

      if (!isMounted) return;

      const { exists, data } = result;
      setIsRegistered(exists || !!(data as { isRegistered?: boolean })?.isRegistered);

      console.log("Profile loaded");

    } catch (error) {
      console.error("Profile loading failed:", error);
      if (!isMounted) return;
      setIsRegistered(false);
    }

    return () => {
      isMounted = false;
    };
  };

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    // Connection test removed in favor of databaseService lazy fallback
  }, []);

  useEffect(() => {
    console.log("Initializing auth...");
    let isMounted = true;

    const unsubscribe = authService.onAuthStateChanged((user) => {
      console.log("Auth state changed:", user);
      if (!isMounted) return;

      setUser(user || null);

      // Profile loading happens separately
      if (user) {
        loadUserProfile(user.uid);
      } else {
        setIsRegistered(false);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);


  useEffect(() => {
    if (!user || !isRegistered) return;

    // Fetch Chats
    const chatsRef = collection(db, 'chats');
    const chatsQuery = query(
      chatsRef,
      where('participants', 'array-contains', user.uid),
      orderBy('lastMessageTime', 'desc')
    );

    const unsubscribeChats = onSnapshot(chatsQuery, (snapshot) => {
      const chatData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Chat[];
      setChats(chatData);
    });

    // Fetch Calls
    const callsRef = collection(db, 'users', user.uid, 'calls');
    const callsQuery = query(callsRef, orderBy('startTime', 'desc'));

    const unsubscribeCalls = onSnapshot(callsQuery, (snapshot) => {
      const callData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as CallRecord[];
      setCalls(callData);
    });

    return () => {
      unsubscribeChats();
      unsubscribeCalls();
    };
  }, [user, isRegistered]);

  // Listen for incoming calls
  useEffect(() => {
    if (!user || !isRegistered) return;

    const callsRef = collection(db, 'calls');
    const incomingQuery = query(
      callsRef,
      where('receiverId', '==', user.uid),
      where('status', '==', 'ringing'),
      limit(1)
    );

    let isMounted = true;
    let pendingFetch: Promise<any> | null = null;

    const unsubscribe = onSnapshot(incomingQuery, async (snapshot) => {
      if (!snapshot.empty) {
        const callData = snapshot.docs[0].data();
        const callId = snapshot.docs[0].id;

        // Create a unique fetch promise
        const fetchPromise = (async () => {
          try {
            const callerDoc = await getDoc(doc(db, 'users', callData.callerId));
            const callerData = callerDoc.data();
            return {
              id: callId,
              ...callData,
              callerName: callerData?.displayName || 'Unknown Caller',
              callerPhoto: callerData?.photoURL
            };
          } catch (error) {
            console.error('Error fetching caller info:', error);
            return {
              id: callId,
              ...callData,
              callerName: 'Unknown Caller',
              callerPhoto: undefined
            };
          }
        })();

        pendingFetch = fetchPromise;

        const result = await fetchPromise;
        // Only set state if this is still the latest fetch and component is mounted
        if (isMounted && pendingFetch === fetchPromise) {
          setIncomingCall(result);
        }
      } else {
        if (isMounted) {
          setIncomingCall(null);
        }
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [user, isRegistered]);

  const handleLogin = async () => {
    setLoginError(null);
    try {
      await authService.signInWithGoogle();
    } catch (error: any) {
      console.error("Login failed", error);
      if (error.message.includes('Redirecting')) return;

      if (error.code === 'auth/unauthorized-domain') {
        setLoginError('This domain is not authorized. Please add the current URL to your Firebase Console > Authentication > Settings > Authorized domains.');
      } else if (error.code === 'auth/popup-blocked') {
        setLoginError('The login popup was blocked by your browser. Please allow popups for this site and try again.');
      } else {
        setLoginError(error.message || 'Login failed. Please try again.');
      }
    }
  };

  const resolveContactUid = async (contact: Contact, signal?: AbortSignal): Promise<string | undefined> => {
    if (contact.uid) return contact.uid;
    if (contact.phoneNumber) {
      try {
        const uid = await lookupUidByPhone(contact.phoneNumber);
        if (signal?.aborted) return undefined;
        return uid ?? undefined;
      } catch (error) {
        if (signal?.aborted) return undefined;
        console.error('Error looking up contact UID:', error);
        return undefined;
      }
    }
    return undefined;
  };

  const handleStartCall = async (contact: Contact, type: 'voice' | 'video') => {
    const abortController = new AbortController();
    try {
      const contactId = await resolveContactUid(contact, abortController.signal);
      if (!contactId) {
        console.error('Cannot call: contact is not registered on Dcalls');
        return;
      }
      if (abortController.signal.aborted) return;

      console.log(`[Call] Starting ${type} call to ${contactId} (${contact.displayName})`);
      setActiveCall({
        type,
        contactName: contact.displayName,
        contactPhoto: contact.photoURL,
        contactId,
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error('Error starting call:', error);
      }
    }
    return () => abortController.abort();
  };

  const handleStartChat = async (contact: Contact) => {
    const abortController = new AbortController();
    if (!user) return () => abortController.abort();

    try {
      const partnerUid = await resolveContactUid(contact, abortController.signal);
      if (!partnerUid) return;
      if (abortController.signal.aborted) return;

      // Check if chat already exists
      const existingChat = chats.find(c =>
        c.type === 'private' && c.participants.includes(partnerUid)
      );

      if (existingChat) {
        setActiveTab('chats');
        return;
      }

      // Create new chat
      await addDoc(collection(db, 'chats'), {
        participants: [user.uid, partnerUid],
        type: 'private',
        lastMessage: '',
        lastMessageTime: serverTimestamp()
      });

      if (!abortController.signal.aborted) {
        setActiveTab('chats');
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error("Error creating chat:", error);
      }
    }
    return () => abortController.abort();
  };

  const filteredCalls = calls.filter(call => {
    // Simplified filtering
    return true;
  });

  const renderTabContent = () => {
    switch (activeTab) {
      case 'chats':
        return (
          <FeatureErrorBoundary featureName="Messages">
            <ChatScreen searchQuery={searchQuery} />
          </FeatureErrorBoundary>
        );
      case 'calls':
        return (
          <FeatureErrorBoundary featureName="Call History">
            <CallLog calls={filteredCalls} />
          </FeatureErrorBoundary>
        );
      case 'contacts':
        return (
          <FeatureErrorBoundary featureName="Contacts">
            <ContactsTab
              onCall={handleStartCall}
              onMessage={handleStartChat}
              onAddContact={() => setIsAddingContact(true)}
              searchQuery={searchQuery}
            />
          </FeatureErrorBoundary>
        );
      case 'damai':
        return (
          <FeatureErrorBoundary featureName="Damai Assistant">
            <DamaiTab />
          </FeatureErrorBoundary>
        );
      case 'settings':
        return (
          <FeatureErrorBoundary featureName="Settings">
            <SettingsTab user={user} />
          </FeatureErrorBoundary>
        );
      default:
        return null;
    }
  };

  if (!user) {
    return (
      <div className="h-screen bg-[#0a0a0a] flex flex-col items-center justify-center p-6 text-center space-y-8 overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/10 via-transparent to-purple-500/10 pointer-events-none" />

        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="w-24 h-24 rounded-[2.5rem] bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-[0_0_50px_rgba(139,92,246,0.3)] relative z-10"
        >
          <DcallsIcon size={48} className="text-white" />
        </motion.div>

        <div className="space-y-3 z-10">
          <h1 className="text-5xl font-black tracking-tighter text-white">Dcalls</h1>
          <p className="text-gray-400 text-sm max-w-[250px] mx-auto leading-relaxed">
            The next generation of messaging. Secure, fluid, and powered by <span className="text-purple-400 font-bold">Damai AI</span>.
          </p>
        </div>

        <div className="flex flex-col gap-4 w-full max-w-[280px] z-10">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setShowRegistration(true)}
            className="flex items-center justify-center gap-3 w-full py-4 bg-indigo-600 text-white rounded-3xl font-bold uppercase tracking-widest text-[10px] shadow-xl shadow-indigo-600/20"
          >
            <UserPlus size={16} />
            Sign Up
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleLogin}
            className="flex items-center justify-center gap-3 w-full py-4 bg-white/5 border border-white/10 text-white rounded-3xl font-bold uppercase tracking-widest text-[10px] hover:bg-white/10 transition-colors"
          >
            <LogIn size={16} />
            Sign in with Google
          </motion.button>

          {loginError && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-[10px] text-red-400 font-medium leading-relaxed"
            >
              {loginError}
            </motion.div>
          )}
        </div>

        <AnimatePresence>
          {showRegistration && (
            <FeatureErrorBoundary
              featureName="Registration"
              onReset={() => setShowRegistration(false)}
            >
              <RegistrationScreen
                onComplete={(data) => {
                  setRegistrationData(data);
                  setShowRegistration(false);
                  setShowPhoneAuth(true);
                }}
                onBack={() => setShowRegistration(false)}
              />
            </FeatureErrorBoundary>
          )}
          {showPhoneAuth && (
            <FeatureErrorBoundary
              featureName="Phone Authentication"
              onReset={() => setShowPhoneAuth(false)}
            >
              <PhoneAuthScreen
                phoneNumber={registrationData?.phoneNumber}
                onSuccess={() => {
                  setShowPhoneAuth(false);
                }}
                onBack={() => {
                  setShowPhoneAuth(false);
                  if (registrationData) setShowRegistration(true);
                }}
              />
            </FeatureErrorBoundary>
          )}
        </AnimatePresence>

        <button
          type="button"
          onClick={() => openMarketing()}
          className="absolute bottom-12 text-[10px] text-gray-500 font-bold uppercase tracking-[0.35em] z-10 hover:text-purple-400 transition-colors"
        >
          Learn more at Dcalls.com
        </button>
      </div>
    );
  }

  if (!isRegistered) {
    if (registrationData) {
      return (
        <PhoneAuthScreen
          phoneNumber={registrationData.phoneNumber}
          onSuccess={async () => {
            if (!user) return;
            try {
              const userRef = doc(db, 'users', user.uid);
              await setDoc(userRef, {
                uid: user.uid,
                ...registrationData,
                photoURL: user.photoURL,
                isRegistered: true,
                lastSeen: serverTimestamp(),
                createdAt: serverTimestamp(),
              }, { merge: true });
              setIsRegistered(true);
            } catch (error) {
              console.error("Failed to complete registration", error);
            }
          }}
          onBack={() => setRegistrationData(null)}
        />
      );
    }
    return (
      <RegistrationScreen
        onComplete={(data) => {
          setRegistrationData(data);
        }}
      />
    );
  }

  const getTitle = () => {
    switch (activeTab) {
      case 'chats': return 'Messages';
      case 'calls': return 'Call History';
      case 'contacts': return 'Contacts';
      case 'damai': return 'Damai Assistant';
      case 'settings': return 'Profile';
      default: return 'Dcalls';
    }
  };

  return (
    <>
      <FeatureErrorBoundary featureName="Layout">
        <Layout
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActiveTab(tab);
            setSearchQuery('');
          }}
          title={getTitle()}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        >
          {renderTabContent()}
        </Layout>
      </FeatureErrorBoundary>

      <AnimatePresence>
        {isOffline && (
          <motion.div
            initial={{ y: -100 }}
            animate={{ y: 0 }}
            exit={{ y: -100 }}
            className="fixed top-0 left-0 right-0 z-[1000] bg-red-500 text-white py-2 px-4 text-center text-xs font-bold uppercase tracking-widest flex items-center justify-center gap-2"
          >
            <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
            You are currently offline. Some features may be unavailable.
          </motion.div>
        )}
        {activeCall && (
          <FeatureErrorBoundary
            featureName="Call"
            onReset={() => setActiveCall(null)}
          >
            <CallingScreen
              type={activeCall.type}
              contactName={activeCall.contactName}
              contactPhoto={activeCall.contactPhoto}
              contactId={activeCall.contactId}
              incomingCallId={activeCall.incomingCallId}
              onEnd={() => {
                setActiveCall(null);
                setActiveTab('contacts');
              }}
            />
          </FeatureErrorBoundary>
        )}
        {incomingCall && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed inset-0 z-[300] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <div className="bg-[#1a1a1a] border border-white/10 rounded-[2.5rem] p-8 w-full max-w-sm text-center space-y-8 shadow-2xl">
              <div className="relative mx-auto w-32 h-32">
                <div className="absolute inset-0 rounded-full border-4 border-emerald-500/30 animate-ping" />
                <img
                  src={incomingCall.callerPhoto || `https://picsum.photos/seed/${incomingCall.callerName}/200/200`}
                  alt=""
                  className="w-full h-full rounded-full object-cover border-4 border-white/10 relative z-10"
                />
              </div>

              <div className="space-y-2">
                <h3 className="text-2xl font-bold tracking-tight">{incomingCall.callerName}</h3>
                <p className="text-emerald-400 font-bold uppercase tracking-widest text-[10px] animate-pulse">Incoming {incomingCall.type} Call...</p>
              </div>

              <div className="flex items-center justify-center gap-6">
                <button
                  onClick={async () => {
                    const path = `calls/${incomingCall.id}`;
                    try {
                      await updateDoc(doc(db, 'calls', incomingCall.id), { status: 'ended' });
                      setIncomingCall(null);
                    } catch (err) {
                      handleFirestoreError(err, OperationType.UPDATE, path);
                    }
                  }}
                  className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center text-white shadow-xl shadow-red-500/20 active:scale-90 transition-all"
                >
                  <PhoneOff size={28} />
                </button>
                <button
                  onClick={() => {
                    console.log(`[Call] Accepting incoming call ${incomingCall.id} from ${incomingCall.callerId}`);
                    // Set incoming to null first to prevent both modals rendering
                    setIncomingCall(null);
                    setActiveCall({
                      type: incomingCall.type,
                      contactName: incomingCall.callerName,
                      contactPhoto: incomingCall.callerPhoto,
                      contactId: incomingCall.callerId,
                      incomingCallId: incomingCall.id
                    });
                  }}
                  className="w-16 h-16 bg-emerald-500 rounded-full flex items-center justify-center text-white shadow-xl shadow-emerald-500/20 active:scale-90 transition-all"
                >
                  <Phone size={28} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
        {isAddingContact && (
          <FeatureErrorBoundary
            featureName="Add Contact"
            onReset={() => setIsAddingContact(false)}
          >
            <AddContactScreen onBack={() => setIsAddingContact(false)} />
          </FeatureErrorBoundary>
        )}
      </AnimatePresence>

      {/* Floating Action Button for Calls (Demo) */}
      {(activeTab === 'calls' || activeTab === 'contacts') && (
        <motion.button
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          onClick={() => setActiveTab('contacts')}
          className="fixed bottom-24 right-6 w-14 h-14 bg-emerald-500 rounded-2xl flex items-center justify-center text-white shadow-xl shadow-emerald-500/30 z-40 active:scale-90 transition-all"
        >
          <Phone size={24} />
        </motion.button>
      )}

      {/* Floating Action Button for Adding Contacts */}
      {(activeTab === 'chats' || activeTab === 'contacts') && (
        <motion.button
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          onClick={() => setIsAddingContact(true)}
          className={cn(
            "fixed bottom-24 right-6 w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-xl shadow-indigo-600/30 z-40 active:scale-90 transition-all",
            activeTab === 'contacts' && "right-24"
          )}
        >
          <UserPlus size={24} />
        </motion.button>
      )}
    </>
  );
}
