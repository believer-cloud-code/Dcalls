# Firestore-Driven Call Architecture

This document describes how the Dcalls application handles all incoming and outgoing calls **entirely through Firestore**, with no Cloud Functions dependency.

## Architecture Overview

The application uses **Firestore real-time listeners (onSnapshot)** to drive the entire call lifecycle. There are no server-side functions handling call logic—all coordination happens through Firestore document reads/writes and real-time updates.

## Firestore Collections

### 1. `calls` Collection
Main collection storing active and historical calls.

**Document Structure:**
```typescript
{
  callerId: string;          // UID of call initiator
  receiverId: string;        // UID of call recipient
  type: 'voice' | 'video';   // Call type
  status: 'ringing' | 'active' | 'ended';
  createdAt: Timestamp;      // Call start time
  endedAt?: Timestamp;       // Call end time (if ended)
}
```

**Sub-collections:**
- `offer/sdp` - WebRTC offer SDP
- `answer/sdp` - WebRTC answer SDP
- `candidates` - ICE candidates from both peers

### 2. `users/{userId}/calls` Collection
User-specific call history for analytics and UI display.

### 3. `users` Collection
User profiles including authentication tokens and messaging endpoints.

## Call Flow

### Outgoing Call (Initiator)

1. **User Initiates Call** (`App.tsx:handleStartCall`)
   - User clicks "Call" on a contact
   - WebRTC local stream is started

2. **Create Call Document** (`webrtcService.ts:createCall`)
   ```typescript
   await setDoc(callDoc, { 
     callerId,          // Current user
     receiverId,        // Contact to call
     type,              // 'voice' or 'video'
     status: 'ringing', // Initial status
     createdAt: serverTimestamp() 
   });
   ```

3. **Create Offer SDP**
   ```typescript
   const offerDescription = await pc.createOffer();
   await setDoc(offerDoc, {
     sdp: offerDescription.sdp,
     type: offerDescription.type,
     createdAt: serverTimestamp()
   });
   ```

4. **Listen for Answer** (`onSnapshot`)
   - Real-time listener watches `answer/sdp` subcollection
   - When answer arrives, set remote description

5. **Exchange ICE Candidates** (`onSnapshot`)
   - Both peers listen to `calls/{callId}/candidates` collection
   - New candidates trigger `addIceCandidate()`
   - 30-second timeout auto-rejects unanswered calls

### Incoming Call (Receiver)

1. **Listen for Incoming Calls** (`App.tsx:useEffect`)
   ```typescript
   const incomingQuery = query(
     collection(db, 'calls'),
     where('receiverId', '==', user.uid),
     where('status', '==', 'ringing'),
     limit(1)
   );
   
   const unsubscribe = onSnapshot(incomingQuery, async (snapshot) => {
     // Set incoming call UI when new ringing call arrives
     setIncomingCall({
       id: callId,
       ...callData,
       callerName: callerData?.displayName,
       callerPhoto: callerData?.photoURL
     });
   });
   ```

2. **User Accepts Call** (`CallingScreen.tsx`)
   - User taps "Accept" button
   - `WebRTCService.joinCall()` is called

3. **Join Call Process** (`webrtcService.ts:joinCall`)
   ```typescript
   // 1. Get caller's offer
   const offerData = await getDoc(offerDoc);
   await pc.setRemoteDescription(new RTCSessionDescription(offerData));
   
   // 2. Create answer
   const answerDescription = await pc.createAnswer();
   await pc.setLocalDescription(answerDescription);
   
   // 3. Send answer back
   await setDoc(answerDoc, {
     type: answerDescription.type,
     sdp: answerDescription.sdp,
     createdAt: serverTimestamp()
   });
   
   // 4. Update status to active
   await updateDoc(callDoc, { status: 'active' });
   
   // 5. Listen for ICE candidates
   onSnapshot(candidatesCol, (snapshot) => {
     // Process incoming candidates
   });
   ```

3. **User Rejects Call**
   - Call document remains with `status: 'ringing'` until timeout (30s)
   - Or can be manually ended via `endCall()`

### Call Termination

When either peer ends the call:
```typescript
await updateDoc(callDoc, { 
  status: 'ended', 
  endedAt: serverTimestamp() 
});

// Cleanup: close peer connection and unsubscribe listeners
this.cleanup();
```

The `onCallEnded` listener triggers callback for UI cleanup:
```typescript
onCallEnded(callback: () => void) {
  return onSnapshot(callDoc, (snapshot) => {
    if (snapshot.data()?.status === 'ended') {
      callback();
    }
  });
}
```

## Real-Time Synchronization Points

| Action | Firestore Write | Listener | Effect |
|--------|-----------------|----------|--------|
| Call initiated | `calls/{id}` status='ringing' | Receiver's incoming query | Shows incoming call UI |
| Call accepted | `calls/{id}` status='active' + answer SDP | Caller's answer listener | Establishes peer connection |
| ICE candidate found | `calls/{id}/candidates` + new doc | Both peers' candidate listeners | Adds ICE candidate for routing |
| Call ended | `calls/{id}` status='ended' | Both peers' call listener | Triggers cleanup and UI close |
| Call timeout (30s) | `calls/{id}` status='ended' | Initiator timeout handler | Auto-rejects unanswered calls |

## Advantages of Firestore-Only Architecture

✅ **No Server Logic**: All coordination happens client-side through Firestore  
✅ **Real-Time Updates**: Instant notification of call state changes  
✅ **Scalable**: Firebase handles concurrency and data sync  
✅ **Cost-Effective**: No Cloud Functions compute charges  
✅ **Simple**: Fewer moving parts to maintain  
✅ **Offline-Resilient**: Firestore SDK handles connection failures  

## Notification System

- **Firebase Cloud Messaging (FCM)** used for native mobile push notifications
- When call status changes to 'ringing', sending device can optionally trigger FCM notification
- But all call coordination remains Firestore-based
- Mobile app can re-sync call state on resume via `onSnapshot`

## Security & Firestore Rules

Key rule: Only recipient and caller can access their own call documents:
```
allow read: if request.auth.uid in resource.data.callerId || resource.data.receiverId;
allow create: if request.auth.uid == resource.data.callerId;
```

## No Cloud Functions

This architecture **eliminates the need for Cloud Functions entirely**:
- ❌ No function to handle call initiation
- ❌ No function to route calls
- ❌ No function to handle call acceptance
- ❌ No function to manage timeouts
- ✅ All handled by client-side Firestore listeners
