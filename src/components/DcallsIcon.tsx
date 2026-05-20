import React from 'react';

export const DcallsIcon: React.FC<{ size?: number, className?: string }> = ({ size = 24, className }) => {
  return (
    <img 
      src="/logo.png" 
      alt="Dcalls" 
      style={{ 
        width: `${size}px`, 
        height: `${size}px`,
        objectFit: 'contain'
      }}
      className={className}
    />
  );
};
