import React from 'react';

export const DcallsIcon: React.FC<{ size?: number, className?: string }> = ({ size = 24, className }) => {
  const src = '/logo.svg';
  return (
    <img
      src={src}
      alt="Dcalls"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        objectFit: 'contain'
      }}
      onError={(e) => { (e.target as HTMLImageElement).src = '/logo.png'; }}
      className={className}
    />
  );
};

export const DamaiIcon: React.FC<{ size?: number, className?: string }> = ({ size = 24, className }) => (
  <img src="/damai.png" alt="Damai" style={{ width: `${size}px`, height: `${size}px`, objectFit: 'contain' }} className={className} />
);
