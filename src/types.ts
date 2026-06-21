import { Timestamp } from 'firebase/firestore';

export interface UserProfile {
  uid: string;
  displayName?: string;
  email?: string;
  phoneNumber?: string;
  password?: string;
  photoURL?: string;
  status?: string;
  lastSeen?: Timestamp;
  isRegistered?: boolean;
  publicKey?: any;
}

export interface Chat {
  id: string;
  participants: string[];
  lastMessage?: string;
  lastMessageTime?: Timestamp;
  type: 'private' | 'group';
}

export interface Message {
  id: string;
  /** Client-generated ID written to Firestore for optimistic reconciliation */
  clientId?: string;
  chatId: string;
  senderId: string;
  text: string;
  timestamp: Timestamp;
  type: 'text' | 'image' | 'audio' | 'system' | 'file';
  isAi?: boolean;
  isEncrypted?: boolean;
  encryptionMethod?: 'rsa' | 'symmetric';
  fileUrl?: string;
  // Extended statuses include optimistic and error states used by the UI
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  feedback?: 'positive' | 'negative';
}

export interface CallRecord {
  id: string;
  participants: string[];
  startTime: Timestamp;
  endTime?: Timestamp;
  type: 'voice' | 'video';
  status: 'missed' | 'completed' | 'ongoing';
  direction?: 'incoming' | 'outgoing';
  callerId?: string;
  summary?: string;
}

export interface Contact {
  id: string;
  ownerId: string;
  phoneNumber: string;
  displayName: string;
  uid?: string;
  photoURL?: string;
}

export interface Recording {
  id: string;
  callId: string;
  ownerId: string;
  duration: number;
  timestamp: any;
  url: string;
  summary?: string;
}

export type TabType = 'chats' | 'calls' | 'contacts' | 'damai' | 'settings';

export type DamaiPersona = 'professional' | 'friendly' | 'concise';
