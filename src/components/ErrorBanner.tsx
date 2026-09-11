import React from 'react';

export const ErrorBanner: React.FC<{ message: string | null; onClose: () => void }> = ({ message, onClose }) => {
  if (!message) return null;
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[300] bg-rose-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-3">
      <div className="text-sm">{message}</div>
      <button onClick={onClose} className="ml-4 px-2 py-1 bg-white/10 rounded-md text-xs">Dismiss</button>
    </div>
  );
};
