import test from 'node:test';
import assert from 'node:assert/strict';
import { getFriendlyErrorMessage } from '../src/utils/errorMessages.ts';

test('permission errors never expose raw Firestore permission text', () => {
 const message=getFriendlyErrorMessage({code:'permission-denied',message:'Missing or insufficient permissions.'});
 assert.match(message,/do not have permission/i); assert.doesNotMatch(message,/Missing or insufficient permissions/i);
});
test('offline errors give a useful next action', () => {
 const message=getFriendlyErrorMessage({code:'unavailable',message:'The client is offline.'});
 assert.match(message,/connection/i); assert.match(message,/try again/i);
});
test('Dcalls domain errors remain understandable', () => {
 const message=getFriendlyErrorMessage(new Error('This pairing session has expired. Create a new QR code.'));
 assert.equal(message,'This pairing session has expired. Create a new QR code and try again.');
});
test('unknown technical exceptions use a safe fallback', () => {
 const message=getFriendlyErrorMessage(new TypeError("Cannot read properties of undefined (reading 'uid')"));
 assert.match(message,/Something went wrong/i); assert.doesNotMatch(message,/undefined|uid/i);
});
test('removed-device errors explain how to recover', () => {
 const message=getFriendlyErrorMessage(new Error('This device has been revoked and cannot publish keys again.'));
 assert.match(message,/removed from the account/i); assert.match(message,/trusted device/i);
});
