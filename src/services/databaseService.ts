import { db as firebaseDb, storage } from '../firebase';
import {
  ref,
  uploadBytes,
  getDownloadURL
} from 'firebase/storage';
import {
  collection,
  addDoc,
  getDoc,
  setDoc,
  updateDoc,
  doc,
  getDocs,
  query,
  DocumentSnapshot,
  DocumentData
} from 'firebase/firestore';
import { CacheService } from './cacheService';

class DatabaseService {
  private cache = CacheService.getInstance();

  async addDocument(path: string, data: any) {
    const colRef = collection(firebaseDb, path);
    const result = await addDoc(colRef, data);
    // Update cache
    this.cache.set(`${path}_${result.id}`, data);
    return result;
  }

  async setDocument(path: string, id: string, data: any) {
    const docRef = doc(firebaseDb, path, id);
    const result = await setDoc(docRef, data);
    // Update cache
    this.cache.set(`${path}_${id}`, data);
    return result;
  }

  async updateDocument(path: string, id: string, data: any) {
    const docRef = doc(firebaseDb, path, id);
    const result = await updateDoc(docRef, data);
    // Update cache
    const current = this.cache.get(`${path}_${id}`) || {};
    this.cache.set(`${path}_${id}`, { ...current, ...data });
    return result;
  }

  async getDocument(path: string, id: string) {
    // Check cache first
    const cached = this.cache.get(`${path}_${id}`);
    if (cached) {
      return { exists: true, data: cached };
    }

    try {
      const docRef = doc(firebaseDb, path, id);
      const snapshot = await Promise.race<DocumentSnapshot<DocumentData>>([
        getDoc(docRef),
        new Promise<DocumentSnapshot<DocumentData>>((_, reject) =>
          setTimeout(() => reject(new Error("Firestore timeout")), 5000)
        )
      ]);

      if (snapshot.exists()) {
        const data = snapshot.data();
        this.cache.set(`${path}_${id}`, data);
        return { exists: true, data };
      }
      return { exists: false, data: null };
    } catch (e: any) {
      console.error('Error fetching document:', e);
      throw e;
    }
  }

  async getDocuments(path: string, constraints: any[] = []) {
    // Check cache for collection
    const cached = this.cache.get(`collection_${path}`);
    if (cached) {
      return cached;
    }

    try {
      const colRef = collection(firebaseDb, path);
      // If constraints provided, apply them to the query
      const q = constraints && constraints.length > 0 ? query(colRef, ...constraints) : colRef;
      const snapshot = await getDocs(q as any);
      const data = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      this.cache.set(`collection_${path}`, data);
      return data;
    } catch (e: any) {
      console.error('Error fetching documents:', e);
      throw e;
    }
  }

  async uploadFile(path: string, file: File | Blob) {
    try {
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      return await getDownloadURL(storageRef);
    } catch (e) {
      console.error('Firebase Storage error:', e);
      throw e;
    }
  }
}

export const databaseService = new DatabaseService();
