import { doc, setDoc, Timestamp } from 'firebase/firestore';
import { db } from '../firebase';

export interface SaveCallHistoryInput {
  userId: string;
  callId: string;
  otherUserId: string;
  contactName: string;
  type: 'voice' | 'video';
  direction: 'incoming' | 'outgoing';
  status: 'missed' | 'completed';
  startedAt: Date;
  endedAt: Date;
  duration: number;
}

export async function saveCallHistory(input: SaveCallHistoryInput): Promise<void> {
  const {
    userId,
    callId,
    otherUserId,
    contactName,
    type,
    direction,
    status,
    startedAt,
    endedAt,
    duration,
  } = input;

  if (!userId || !callId || !otherUserId || userId === otherUserId) {
    throw new Error('Cannot save call history without two distinct call participants.');
  }

  // Use the WebRTC call ID as the history document ID. This makes repeated
  // end events and offline recovery idempotent instead of creating duplicates.
  await setDoc(doc(db, 'users', userId, 'calls', callId), {
    contactId: otherUserId,
    contactName,
    type,
    status,
    direction,
    callerId: direction === 'incoming' ? otherUserId : userId,
    participants: [userId, otherUserId],
    startTime: Timestamp.fromDate(startedAt),
    endTime: Timestamp.fromDate(endedAt),
    duration: Math.max(0, Math.floor(duration)),
    updatedAt: Timestamp.fromDate(endedAt),
  }, { merge: true });
}
