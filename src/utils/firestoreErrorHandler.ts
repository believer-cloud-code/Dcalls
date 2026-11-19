import { auth } from '../firebase';
import { getFriendlyErrorMessage } from './errorMessages';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  code?: string;
  operationType: OperationType;
  path: string | null;
}

/** Log non-sensitive diagnostics and throw a safe message for UI callers. */
export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const code = (error as { code?: unknown } | null)?.code;
  console.error('[Firestore operation failed]', {
    code: typeof code === 'string' ? code : 'unknown',
    operationType,
    signedIn: Boolean(auth.currentUser),
  });
  throw new Error(getFriendlyErrorMessage(error));
}
